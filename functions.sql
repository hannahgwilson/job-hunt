-- Job Hunt — shared SQL logic layer
-- ============================================================================
-- These functions are the single implementation of the job-hunt read
-- aggregations and multi-step writes. BOTH planes call them:
--   * the React SPA, directly via supabase-js `.rpc(...)` (RLS-scoped to the
--     logged-in auth user), and
--   * the job-hunt MCP, whose tools are thin wrappers over these same funcs.
--
-- Why functions instead of TypeScript-in-the-edge-function:
--   * the funnel / action-queue logic is written ONCE, in the DB, so the app
--     and the agent never drift, and
--   * the "intake a role" write is a real transaction (org find-or-create +
--     posting insert) instead of chained client-side inserts — that was the
--     brittleness this layer removes.
--
-- Security model: every function is SECURITY INVOKER (the default), so the
-- base-table RLS policies apply. `p_user_id` defaults to `auth.uid()` for the
-- SPA path; the MCP (service role, which bypasses RLS) passes DEFAULT_USER_ID
-- explicitly. A SPA caller cannot write rows for another user because the
-- RLS WITH CHECK (auth.uid() = user_id) on the base tables still applies.
--
-- Re-runnable: all CREATE OR REPLACE. Apply after schema.sql.
-- ============================================================================


-- ============================================================================
-- READS
-- ============================================================================

-- get_funnel_metrics — true conversion + median days-from-applied, computed
-- from application_status_history. Ported from the v2 TypeScript handler.
CREATE OR REPLACE FUNCTION get_funnel_metrics(
    p_window_days int DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH hist AS (
        -- first time each application reached each status
        SELECT application_id, to_status, MIN(changed_at) AS reached_at
        FROM application_status_history
        WHERE user_id = p_user_id
          AND (p_window_days IS NULL
               OR changed_at >= now() - make_interval(days => p_window_days))
        GROUP BY application_id, to_status
    ),
    stages AS (
        SELECT * FROM (VALUES
            ('applied', 1), ('screening', 2), ('interviewing', 3),
            ('offer', 4), ('accepted', 5)
        ) AS s(stage, ord)
    ),
    counts AS (
        SELECT s.stage, s.ord, COUNT(DISTINCT h.application_id) AS cnt
        FROM stages s
        LEFT JOIN hist h ON h.to_status = s.stage
        GROUP BY s.stage, s.ord
    ),
    applied AS (
        SELECT application_id, reached_at AS applied_at
        FROM hist WHERE to_status = 'applied'
    ),
    days AS (
        SELECT s.stage,
               EXTRACT(EPOCH FROM (h.reached_at - a.applied_at)) / 86400.0 AS d
        FROM stages s
        JOIN hist h ON h.to_status = s.stage
        JOIN applied a ON a.application_id = h.application_id
        WHERE s.stage <> 'applied'
    ),
    medians AS (
        SELECT s.stage,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.d) AS med
        FROM stages s
        LEFT JOIN days d ON d.stage = s.stage
        WHERE s.stage <> 'applied'
        GROUP BY s.stage
    )
    SELECT jsonb_build_object(
        'success', true,
        'window_days', p_window_days,
        'sample_size', (SELECT COUNT(DISTINCT application_id) FROM hist),
        'stage_counts', (SELECT jsonb_object_agg(stage, cnt) FROM counts),
        'conversion_rates', (
            SELECT jsonb_object_agg(stage_pair, rate)
            FROM (
                SELECT lag(c.stage) OVER (ORDER BY c.ord) || '_to_' || c.stage AS stage_pair,
                       lag(c.cnt)   OVER (ORDER BY c.ord) AS prev_cnt,
                       CASE WHEN lag(c.cnt) OVER (ORDER BY c.ord) > 0
                            THEN round(c.cnt::numeric / lag(c.cnt) OVER (ORDER BY c.ord), 3)
                            ELSE NULL END AS rate
                FROM counts c
            ) conv
            WHERE conv.prev_cnt IS NOT NULL
        ),
        'median_days_from_applied', (
            SELECT jsonb_object_agg(stage, CASE WHEN med IS NULL THEN NULL ELSE round(med::numeric, 1) END)
            FROM medians
        )
    ) INTO result;

    RETURN result;
END;
$$;


-- compute_priority — pure scoring of ONE posting (the prioritization algorithm).
-- Takes the raw signals, returns { score (0..100), components (0..1 each),
-- weights }. IMMUTABLE so it can be called per-row in a query without
-- re-planning. Defined here (above its first caller, get_action_queue) because
-- SQL-language functions validate referenced functions at creation time.
-- The canonical spec is semantic/metrics/priority_score.yaml — the weights and
-- comp band below are duplicated there; keep them in sync.
CREATE OR REPLACE FUNCTION compute_priority(
    p_experience_alignment numeric,
    p_location text,
    p_remote_policy text,
    p_salary_min int,
    p_salary_max int,
    p_career_trajectory text,
    p_growth_stage text,
    p_weights jsonb DEFAULT
        '{"experience":0.35,"location":0.15,"comp":0.15,"career":0.20,"growth":0.15}'::jsonb,
    p_comp_floor int DEFAULT 120000,
    p_comp_target int DEFAULT 220000
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    f_experience numeric;
    f_location   numeric;
    f_comp       numeric;
    f_career     numeric;
    f_growth     numeric;
    v_is_nyc     boolean;
    v_mid        numeric;
    v_score      numeric;
BEGIN
    -- experience: agent-judged 0..1, null → neutral 0.5
    f_experience := COALESCE(p_experience_alignment, 0.5);

    -- location: preference ladder (hybrid-NYC > remote > onsite-NYC > hybrid-other > onsite-other)
    v_is_nyc := p_location IS NOT NULL AND (
        p_location ILIKE '%new york%' OR p_location ILIKE '%nyc%'
        OR p_location ILIKE '%manhattan%' OR p_location ILIKE '%brooklyn%'
    );
    f_location := CASE
        WHEN p_remote_policy = 'remote'              THEN 0.85
        WHEN p_remote_policy = 'hybrid' AND v_is_nyc THEN 1.00
        WHEN p_remote_policy = 'hybrid'              THEN 0.55
        WHEN p_remote_policy = 'onsite' AND v_is_nyc THEN 0.65
        WHEN p_remote_policy = 'onsite'              THEN 0.25
        WHEN v_is_nyc                                THEN 0.60  -- NYC, policy unknown
        ELSE 0.40                                                -- fully unknown
    END;

    -- comp: linear-normalize the salary midpoint into [floor, target], clamped.
    -- No posted salary → mild 0.40 (unknown, not zero).
    IF p_salary_min IS NULL AND p_salary_max IS NULL THEN
        f_comp := 0.40;
    ELSE
        v_mid := (COALESCE(p_salary_min, p_salary_max)
                  + COALESCE(p_salary_max, p_salary_min)) / 2.0;
        f_comp := GREATEST(0, LEAST(1,
            (v_mid - p_comp_floor)::numeric / NULLIF(p_comp_target - p_comp_floor, 0)));
    END IF;

    -- career: step_up > lateral > step_back, null → neutral
    f_career := CASE p_career_trajectory
        WHEN 'step_up'   THEN 1.00
        WHEN 'lateral'   THEN 0.75
        WHEN 'step_back' THEN 0.25
        ELSE 0.50
    END;

    -- growth: stage → upside, null/unknown → neutral
    f_growth := CASE p_growth_stage
        WHEN 'growth' THEN 1.00
        WHEN 'early'  THEN 0.90
        WHEN 'late'   THEN 0.70
        WHEN 'seed'   THEN 0.65
        WHEN 'public' THEN 0.50
        ELSE 0.50
    END;

    v_score := 100 * (
          COALESCE((p_weights->>'experience')::numeric, 0) * f_experience
        + COALESCE((p_weights->>'location')::numeric,   0) * f_location
        + COALESCE((p_weights->>'comp')::numeric,       0) * f_comp
        + COALESCE((p_weights->>'career')::numeric,     0) * f_career
        + COALESCE((p_weights->>'growth')::numeric,     0) * f_growth
    );

    RETURN jsonb_build_object(
        'score', round(v_score, 1),
        'components', jsonb_build_object(
            'experience', round(f_experience, 2),
            'location',   round(f_location, 2),
            'comp',       round(f_comp, 2),
            'career',     round(f_career, 2),
            'growth',     round(f_growth, 2)
        ),
        'weights', p_weights
    );
END;
$$;


-- get_action_queue — the four buckets the search runs on, in one call:
--   roles_to_apply   — tracked postings with no live application (force-ranked)
--   role_followups   — applications awaiting a response past the threshold
--   upcoming_interviews — scheduled interviews in the next window
--   networking       — job-hunt contacts gone stale / never contacted
CREATE OR REPLACE FUNCTION get_action_queue(
    p_user_id uuid DEFAULT auth.uid(),
    p_followup_days int DEFAULT 7,
    p_closing_days int DEFAULT 7,
    p_interview_days int DEFAULT 14,
    p_stale_days int DEFAULT 14
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        -- Force-ranked by priority_score (see semantic/metrics/priority_score.yaml).
        -- This bucket is the answer to "what do I apply to next" — top card first.
        'roles_to_apply', (
            SELECT coalesce(jsonb_agg(
                scored.rec || jsonb_build_object('rank', scored.rn)
                ORDER BY scored.rn
            ), '[]'::jsonb)
            FROM (
                SELECT
                    to_jsonb(jp) || jsonb_build_object(
                        'organization_name', o.name,
                        'closing_soon', (jp.closing_date IS NOT NULL
                                         AND jp.closing_date <= current_date + p_closing_days),
                        'priority', compute_priority(
                            jp.experience_alignment, jp.location, jp.remote_policy,
                            jp.salary_min, jp.salary_max, jp.career_trajectory,
                            jp.growth_stage)
                    ) AS rec,
                    row_number() OVER (
                        ORDER BY (compute_priority(
                            jp.experience_alignment, jp.location, jp.remote_policy,
                            jp.salary_min, jp.salary_max, jp.career_trajectory,
                            jp.growth_stage)->>'score')::numeric DESC NULLS LAST,
                            jp.closing_date NULLS LAST
                    ) AS rn
                FROM job_postings jp
                JOIN organizations o ON o.id = jp.organization_id
                WHERE jp.user_id = p_user_id
                  AND NOT EXISTS (
                      SELECT 1 FROM applications a
                      WHERE a.job_posting_id = jp.id AND a.status <> 'draft'
                  )
            ) scored
        ),
        'role_followups', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'application_id', a.id,
                    'status', a.status,
                    'applied_date', a.applied_date,
                    'days_waiting', (current_date - a.applied_date),
                    'title', jp.title,
                    'organization_name', o.name,
                    'url', jp.url
                ) ORDER BY a.applied_date ASC
            ), '[]'::jsonb)
            FROM applications a
            JOIN job_postings jp ON jp.id = a.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE a.user_id = p_user_id
              AND a.response_date IS NULL
              AND a.status IN ('applied', 'screening', 'interviewing')
              AND a.applied_date IS NOT NULL
              AND a.applied_date <= current_date - p_followup_days
        ),
        'upcoming_interviews', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'interview_id', i.id,
                    'interview_type', i.interview_type,
                    'scheduled_at', i.scheduled_at,
                    'title', jp.title,
                    'organization_name', o.name
                ) ORDER BY i.scheduled_at ASC
            ), '[]'::jsonb)
            FROM interviews i
            JOIN applications a ON a.id = i.application_id
            JOIN job_postings jp ON jp.id = a.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE i.user_id = p_user_id
              AND i.status = 'scheduled'
              AND i.scheduled_at >= now()
              AND i.scheduled_at <= now() + make_interval(days => p_interview_days)
        ),
        'networking', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'contact_id', c.id,
                    'name', c.name,
                    'title', c.title,
                    'last_contacted', c.last_contacted,
                    'organization_name', o.name
                ) ORDER BY c.last_contacted ASC NULLS FIRST
            ), '[]'::jsonb)
            FROM contacts c
            LEFT JOIN organizations o ON o.id = c.organization_id
            WHERE c.user_id = p_user_id
              AND c.tags && ARRAY['job-hunt']
              AND (c.last_contacted IS NULL
                   OR c.last_contacted <= current_date - p_stale_days)
        )
    );
$$;


-- ============================================================================
-- PRIORITIZATION  (force-rank postings I haven't applied to yet)
-- compute_priority() — the scoring algorithm — is defined above, just before
-- its first caller get_action_queue(). The canonical spec for both lives in
-- semantic/metrics/priority_score.yaml. Weights/comp band are duplicated there.
-- ============================================================================

-- get_prioritized_roles — the roles_to_apply bucket, force-ranked. Postings with
-- no live (non-draft) application, each scored by compute_priority, highest
-- first. The same query backs get_action_queue's roles_to_apply ordering.
CREATE OR REPLACE FUNCTION get_prioritized_roles(
    p_user_id uuid DEFAULT auth.uid(),
    p_closing_days int DEFAULT 7,
    p_limit int DEFAULT NULL,
    p_weights jsonb DEFAULT
        '{"experience":0.35,"location":0.15,"comp":0.15,"career":0.20,"growth":0.15}'::jsonb,
    p_comp_floor int DEFAULT 120000,
    p_comp_target int DEFAULT 220000
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    WITH ranked AS (
        SELECT
            to_jsonb(jp) || jsonb_build_object(
                'organization_name', o.name,
                'closing_soon', (jp.closing_date IS NOT NULL
                                 AND jp.closing_date <= current_date + p_closing_days),
                'priority', compute_priority(
                    jp.experience_alignment, jp.location, jp.remote_policy,
                    jp.salary_min, jp.salary_max, jp.career_trajectory,
                    jp.growth_stage, p_weights, p_comp_floor, p_comp_target)
            ) AS rec,
            compute_priority(
                jp.experience_alignment, jp.location, jp.remote_policy,
                jp.salary_min, jp.salary_max, jp.career_trajectory,
                jp.growth_stage, p_weights, p_comp_floor, p_comp_target)->>'score' AS score
        FROM job_postings jp
        JOIN organizations o ON o.id = jp.organization_id
        WHERE jp.user_id = p_user_id
          AND NOT EXISTS (
              SELECT 1 FROM applications a
              WHERE a.job_posting_id = jp.id AND a.status <> 'draft'
          )
    )
    SELECT jsonb_build_object(
        'success', true,
        'count', (SELECT count(*) FROM ranked),
        'weights', p_weights,
        'roles', COALESCE(
            (SELECT jsonb_agg(
                rec || jsonb_build_object('rank', rn)
                ORDER BY rn)
             FROM (
                SELECT rec, score,
                       row_number() OVER (ORDER BY score::numeric DESC NULLS LAST) AS rn
                FROM ranked
             ) r
             WHERE p_limit IS NULL OR rn <= p_limit
            ), '[]'::jsonb)
    );
$$;


-- ============================================================================
-- WRITES  (the brittleness fix — multi-step intake in one transaction)
-- ============================================================================

-- intake_role — find-or-create the org, then insert the posting, atomically.
-- Returns the org id (+ whether it was newly created) and the full posting.
-- The OB company/role thought is captured separately by the agent via the
-- open-brain MCP (keeps this function decoupled from the brain's queue schema).
--
-- Also accepts the three agent-judged prioritization signals (experience_alignment,
-- career_trajectory, growth_stage) so a role can be scored the moment it's intaked.
-- They're optional — leave them null and set_priority_signals can fill them later.
DROP FUNCTION IF EXISTS intake_role(text, text, text, int, int, text, text[], text[], text, text, text, date, date, text, text[], uuid);
CREATE OR REPLACE FUNCTION intake_role(
    p_org_name text,
    p_title text,
    p_url text DEFAULT NULL,
    p_salary_min int DEFAULT NULL,
    p_salary_max int DEFAULT NULL,
    p_salary_currency text DEFAULT 'USD',
    p_requirements text[] DEFAULT NULL,
    p_nice_to_haves text[] DEFAULT NULL,
    p_location text DEFAULT NULL,
    p_remote_policy text DEFAULT NULL,
    p_source text DEFAULT NULL,
    p_posted_date date DEFAULT NULL,
    p_closing_date date DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_experience_alignment numeric DEFAULT NULL,
    p_career_trajectory text DEFAULT NULL,
    p_growth_stage text DEFAULT NULL,
    p_org_tags text[] DEFAULT ARRAY['employer-target'],
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_org_id uuid;
    v_org_created boolean := false;
    v_posting job_postings;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'intake_role: no user_id (no auth.uid() and none passed)';
    END IF;
    IF coalesce(trim(p_org_name), '') = '' THEN
        RAISE EXCEPTION 'intake_role: org_name is empty';
    END IF;

    -- find-or-create the organization (case-insensitive, soft-unique)
    SELECT id INTO v_org_id
    FROM organizations
    WHERE user_id = p_user_id AND lower(name) = lower(trim(p_org_name))
    LIMIT 1;

    IF v_org_id IS NULL THEN
        INSERT INTO organizations (user_id, name, tags)
        VALUES (p_user_id, trim(p_org_name), coalesce(p_org_tags, '{}'))
        RETURNING id INTO v_org_id;
        v_org_created := true;
    END IF;

    INSERT INTO job_postings (
        user_id, organization_id, title, url,
        salary_min, salary_max, salary_currency,
        requirements, nice_to_haves, location, remote_policy,
        source, posted_date, closing_date, notes,
        experience_alignment, career_trajectory, growth_stage
    )
    VALUES (
        p_user_id, v_org_id, p_title, p_url,
        p_salary_min, p_salary_max, coalesce(p_salary_currency, 'USD'),
        coalesce(p_requirements, '{}'), coalesce(p_nice_to_haves, '{}'),
        p_location, p_remote_policy,
        p_source, p_posted_date, p_closing_date, p_notes,
        p_experience_alignment, p_career_trajectory, p_growth_stage
    )
    RETURNING * INTO v_posting;

    RETURN jsonb_build_object(
        'success', true,
        'organization_id', v_org_id,
        'organization_created', v_org_created,
        'posting', to_jsonb(v_posting)
    );
END;
$$;


-- submit_application — record an application (tracking starts here; the
-- application_status_history trigger logs the initial state automatically).
CREATE OR REPLACE FUNCTION submit_application(
    p_job_posting_id uuid,
    p_referral_contact_id uuid DEFAULT NULL,
    p_status text DEFAULT 'applied',
    p_applied_date date DEFAULT current_date,
    p_resume_version text DEFAULT NULL,
    p_cover_letter_notes text DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_app applications;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'submit_application: no user_id';
    END IF;

    INSERT INTO applications (
        user_id, job_posting_id, referral_contact_id,
        status, applied_date, resume_version, cover_letter_notes, notes
    )
    VALUES (
        p_user_id, p_job_posting_id, p_referral_contact_id,
        coalesce(p_status, 'applied'), p_applied_date,
        p_resume_version, p_cover_letter_notes, p_notes
    )
    RETURNING * INTO v_app;

    RETURN jsonb_build_object('success', true, 'application', to_jsonb(v_app));
END;
$$;


-- advance_application — move an application to a new status (go/no-go
-- transitions). The history trigger records the transition automatically.
CREATE OR REPLACE FUNCTION advance_application(
    p_application_id uuid,
    p_new_status text,
    p_response_date date DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_app applications;
BEGIN
    UPDATE applications
    SET status        = p_new_status,
        response_date = COALESCE(p_response_date, response_date),
        notes         = COALESCE(p_notes, notes)
    WHERE id = p_application_id
      AND user_id = COALESCE(p_user_id, user_id)
    RETURNING * INTO v_app;

    IF v_app.id IS NULL THEN
        RAISE EXCEPTION 'advance_application: application % not found or not owned', p_application_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'application', to_jsonb(v_app));
END;
$$;


-- set_priority_signals — update the agent-judged scoring inputs on a posting
-- after intake (e.g. after re-reading the JD against the resume). Only non-null
-- args are applied, so you can nudge one signal without clobbering the others.
CREATE OR REPLACE FUNCTION set_priority_signals(
    p_job_posting_id uuid,
    p_experience_alignment numeric DEFAULT NULL,
    p_career_trajectory text DEFAULT NULL,
    p_growth_stage text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_posting job_postings;
BEGIN
    UPDATE job_postings
    SET experience_alignment = COALESCE(p_experience_alignment, experience_alignment),
        career_trajectory    = COALESCE(p_career_trajectory, career_trajectory),
        growth_stage         = COALESCE(p_growth_stage, growth_stage)
    WHERE id = p_job_posting_id
      AND user_id = COALESCE(p_user_id, user_id)
    RETURNING * INTO v_posting;

    IF v_posting.id IS NULL THEN
        RAISE EXCEPTION 'set_priority_signals: posting % not found or not owned', p_job_posting_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'posting', to_jsonb(v_posting),
        'priority', compute_priority(
            v_posting.experience_alignment, v_posting.location, v_posting.remote_policy,
            v_posting.salary_min, v_posting.salary_max, v_posting.career_trajectory,
            v_posting.growth_stage)
    );
END;
$$;


-- ============================================================================
-- Grants — both planes. `authenticated` = the SPA's logged-in user (RLS
-- scopes them); `service_role` = the MCP edge function.
-- ============================================================================
GRANT EXECUTE ON FUNCTION get_funnel_metrics(int, uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_action_queue(uuid, int, int, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compute_priority(numeric, text, text, int, int, text, text, jsonb, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_prioritized_roles(uuid, int, int, jsonb, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION intake_role(text, text, text, int, int, text, text[], text[], text, text, text, date, date, text, numeric, text, text, text[], uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION submit_application(uuid, uuid, text, date, text, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION advance_application(uuid, text, date, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_priority_signals(uuid, numeric, text, text, uuid) TO authenticated, service_role;
