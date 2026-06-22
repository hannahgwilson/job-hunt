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


-- ============================================================================
-- PRIORITY WEIGHTS  (user-adjustable — see migration 009)
-- The five component weights are per-user data, edited by the Pipeline sliders.
-- The ranking readers below resolve the caller's row and pass it to
-- compute_priority; with no row they fall back to the neutral spec default, so
-- nothing changes for a user who never touches the sliders. Source of truth for
-- the defaults: semantic/metrics/priority_score.yaml.
-- ============================================================================

-- resolve — the user's stored weights as the jsonb compute_priority wants, or the
-- neutral spec default when unset. Defined before get_action_queue (its caller).
CREATE OR REPLACE FUNCTION resolve_priority_weights(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT jsonb_build_object(
            'experience', experience, 'location', location,
            'comp', comp, 'career', career, 'growth', growth)
         FROM priority_weights WHERE user_id = p_user_id),
        '{"experience":0.35,"location":0.15,"comp":0.15,"career":0.20,"growth":0.15}'::jsonb
    );
$$;

-- get_priority_weights — weights + whether they're customised (UI badge).
CREATE OR REPLACE FUNCTION get_priority_weights(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'is_custom', EXISTS (SELECT 1 FROM priority_weights WHERE user_id = p_user_id),
        'weights', resolve_priority_weights(p_user_id)
    );
$$;

-- save_priority_weights — upsert, normalized so the five levers always sum to 1.0
-- (the sliders move freely; we rescale on save). Returns the fresh get read.
CREATE OR REPLACE FUNCTION save_priority_weights(
    p_experience numeric,
    p_location numeric,
    p_comp numeric,
    p_career numeric,
    p_growth numeric,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_sum numeric;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_priority_weights: no user_id';
    END IF;
    v_sum := COALESCE(p_experience,0) + COALESCE(p_location,0) + COALESCE(p_comp,0)
           + COALESCE(p_career,0) + COALESCE(p_growth,0);
    IF v_sum <= 0 THEN
        RAISE EXCEPTION 'save_priority_weights: weights must sum to a positive value';
    END IF;

    INSERT INTO priority_weights (user_id, experience, location, comp, career, growth)
    VALUES (
        p_user_id,
        round(COALESCE(p_experience,0) / v_sum, 3),
        round(COALESCE(p_location,0)   / v_sum, 3),
        round(COALESCE(p_comp,0)       / v_sum, 3),
        round(COALESCE(p_career,0)     / v_sum, 3),
        round(COALESCE(p_growth,0)     / v_sum, 3)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        experience = EXCLUDED.experience,
        location   = EXCLUDED.location,
        comp       = EXCLUDED.comp,
        career     = EXCLUDED.career,
        growth     = EXCLUDED.growth,
        updated_at = now();

    RETURN get_priority_weights(p_user_id);
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
                            jp.growth_stage, resolve_priority_weights(p_user_id))
                    ) AS rec,
                    row_number() OVER (
                        ORDER BY (compute_priority(
                            jp.experience_alignment, jp.location, jp.remote_policy,
                            jp.salary_min, jp.salary_max, jp.career_trajectory,
                            jp.growth_stage, resolve_priority_weights(p_user_id))->>'score')::numeric DESC NULLS LAST,
                            jp.closing_date NULLS LAST
                    ) AS rn
                FROM job_postings jp
                JOIN organizations o ON o.id = jp.organization_id
                WHERE jp.user_id = p_user_id
                  AND jp.closed_at IS NULL          -- skip closed/filled roles
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
-- p_weights defaults to NULL → resolve the caller's stored weights (or the spec
-- default if unset). An explicit p_weights still overrides, for experimentation.
CREATE OR REPLACE FUNCTION get_prioritized_roles(
    p_user_id uuid DEFAULT auth.uid(),
    p_closing_days int DEFAULT 7,
    p_limit int DEFAULT NULL,
    p_weights jsonb DEFAULT NULL,
    p_comp_floor int DEFAULT 120000,
    p_comp_target int DEFAULT 220000
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    WITH eff AS (
        SELECT COALESCE(p_weights, resolve_priority_weights(p_user_id)) AS w
    ),
    ranked AS (
        SELECT
            to_jsonb(jp) || jsonb_build_object(
                'organization_name', o.name,
                'closing_soon', (jp.closing_date IS NOT NULL
                                 AND jp.closing_date <= current_date + p_closing_days),
                'priority', compute_priority(
                    jp.experience_alignment, jp.location, jp.remote_policy,
                    jp.salary_min, jp.salary_max, jp.career_trajectory,
                    jp.growth_stage, (SELECT w FROM eff), p_comp_floor, p_comp_target)
            ) AS rec,
            compute_priority(
                jp.experience_alignment, jp.location, jp.remote_policy,
                jp.salary_min, jp.salary_max, jp.career_trajectory,
                jp.growth_stage, (SELECT w FROM eff), p_comp_floor, p_comp_target)->>'score' AS score
        FROM job_postings jp
        JOIN organizations o ON o.id = jp.organization_id
        WHERE jp.user_id = p_user_id
          AND jp.closed_at IS NULL                  -- skip closed/filled roles
          AND NOT EXISTS (
              SELECT 1 FROM applications a
              WHERE a.job_posting_id = jp.id AND a.status <> 'draft'
          )
    )
    SELECT jsonb_build_object(
        'success', true,
        'count', (SELECT count(*) FROM ranked),
        'weights', (SELECT w FROM eff),
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
-- CLOSE / REOPEN A ROLE  (posting lifecycle — migration 012)
-- "Filled" is a property of the posting, so it can be closed whether or not I
-- ever applied. close_role stamps closed_at/closed_reason on the posting and —
-- if I'd applied — cascades the still-live application to the terminal 'closed'
-- status (the auto-log trigger records the transition). Terminal applications
-- (accepted/rejected/withdrawn) are left as-is. Once closed_at is set the role
-- drops out of the apply queue, follow-ups, and the analytics scatter.
-- ============================================================================
CREATE OR REPLACE FUNCTION close_role(
    p_job_posting_id uuid,
    p_reason text DEFAULT 'filled',
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_posting job_postings;
    v_apps_closed int;
BEGIN
    UPDATE job_postings
    SET closed_at = COALESCE(closed_at, now()),   -- keep the original close time if re-closed
        closed_reason = p_reason
    WHERE id = p_job_posting_id
      AND user_id = COALESCE(p_user_id, user_id)
    RETURNING * INTO v_posting;

    IF v_posting.id IS NULL THEN
        RAISE EXCEPTION 'close_role: posting % not found or not owned', p_job_posting_id;
    END IF;

    -- Cascade live applications to 'closed' (leave terminal ones untouched).
    WITH closed AS (
        UPDATE applications
        SET status = 'closed'
        WHERE job_posting_id = p_job_posting_id
          AND user_id = v_posting.user_id
          AND status NOT IN ('accepted', 'rejected', 'withdrawn', 'closed')
        RETURNING 1
    )
    SELECT count(*) INTO v_apps_closed FROM closed;

    RETURN jsonb_build_object(
        'success', true,
        'posting', to_jsonb(v_posting),
        'applications_closed', v_apps_closed
    );
END;
$$;

-- reopen_role — undo a close: clear the posting's closed flag so it re-enters the
-- queue. Applications are left as-is (a 'closed' app stays closed; advance it by
-- hand if the role genuinely reopened) — reopening the posting is the common case
-- (closed it by mistake / the role came back) and shouldn't silently rewrite app
-- history.
CREATE OR REPLACE FUNCTION reopen_role(
    p_job_posting_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_posting job_postings;
BEGIN
    UPDATE job_postings
    SET closed_at = NULL,
        closed_reason = NULL
    WHERE id = p_job_posting_id
      AND user_id = COALESCE(p_user_id, user_id)
    RETURNING * INTO v_posting;

    IF v_posting.id IS NULL THEN
        RAISE EXCEPTION 'reopen_role: posting % not found or not owned', p_job_posting_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'posting', to_jsonb(v_posting));
END;
$$;


-- ============================================================================
-- RESUME  (the experience_alignment input — see priority_score.yaml)
-- ============================================================================

-- Resume storage is the `resumes` dim (one row per variant — e.g. a senior-IC
-- resume and a manager resume). get_resume / upsert_resume below are kept as
-- thin shims over the DEFAULT variant so the MCP and the old single-resume path
-- keep working; the variant-aware functions follow them.

-- get_resume — the default resume, for scoring experience alignment.
CREATE OR REPLACE FUNCTION get_resume(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'resume_text', r.resume_text,
        'resume_filename', r.resume_filename,
        'updated_at', r.updated_at,
        'has_resume', (r.resume_text IS NOT NULL AND length(trim(r.resume_text)) > 0)
    )
    FROM (SELECT p_user_id AS uid) base
    LEFT JOIN LATERAL (
        SELECT resume_text, resume_filename, updated_at
        FROM resumes
        WHERE user_id = base.uid
        ORDER BY is_default DESC, created_at
        LIMIT 1
    ) r ON true;
$$;

-- upsert_resume — save / replace the DEFAULT resume's text (back-compat shim).
CREATE OR REPLACE FUNCTION upsert_resume(
    p_resume_text text,
    p_resume_filename text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'upsert_resume: no user_id';
    END IF;

    SELECT id INTO v_id FROM resumes
    WHERE user_id = p_user_id
    ORDER BY is_default DESC, created_at
    LIMIT 1;

    IF v_id IS NULL THEN
        INSERT INTO resumes (user_id, label, variant, resume_text, resume_filename, is_default)
        VALUES (p_user_id, 'My resume', 'other', p_resume_text, p_resume_filename, true)
        RETURNING id INTO v_id;
    ELSE
        UPDATE resumes
        SET resume_text = p_resume_text, resume_filename = p_resume_filename
        WHERE id = v_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_id,
        'resume_filename', p_resume_filename,
        'length', length(coalesce(p_resume_text, ''))
    );
END;
$$;

-- list_resumes — every resume variant for the user, default first.
CREATE OR REPLACE FUNCTION list_resumes(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'resumes', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', r.id,
                'label', r.label,
                'variant', r.variant,
                'resume_text', r.resume_text,
                'resume_filename', r.resume_filename,
                'is_default', r.is_default,
                'updated_at', r.updated_at
            ) ORDER BY r.is_default DESC, r.created_at
        ), '[]'::jsonb)
    )
    FROM resumes r
    WHERE r.user_id = p_user_id;
$$;

-- upsert_resume_variant — create (p_id NULL) or update a named resume variant.
-- The first resume a user creates becomes the default automatically. Setting
-- is_default = true clears any other default first (single-default invariant).
CREATE OR REPLACE FUNCTION upsert_resume_variant(
    p_label text,
    p_resume_text text,
    p_variant text DEFAULT 'other',
    p_resume_filename text DEFAULT NULL,
    p_id uuid DEFAULT NULL,
    p_is_default boolean DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_row resumes;
    v_make_default boolean;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'upsert_resume_variant: no user_id';
    END IF;

    IF p_id IS NULL THEN
        -- new variant: honour p_is_default, else default only if it's the first
        v_make_default := COALESCE(
            p_is_default,
            NOT EXISTS (SELECT 1 FROM resumes WHERE user_id = p_user_id)
        );
        -- clear an existing default BEFORE inserting to satisfy the unique index
        IF v_make_default THEN
            UPDATE resumes SET is_default = false
            WHERE user_id = p_user_id AND is_default;
        END IF;
        INSERT INTO resumes (user_id, label, variant, resume_text, resume_filename, is_default)
        VALUES (p_user_id, p_label, p_variant, p_resume_text, p_resume_filename, v_make_default)
        RETURNING * INTO v_row;
    ELSE
        v_make_default := COALESCE(
            p_is_default,
            (SELECT is_default FROM resumes WHERE id = p_id AND user_id = p_user_id)
        );
        IF v_make_default THEN
            UPDATE resumes SET is_default = false
            WHERE user_id = p_user_id AND id <> p_id AND is_default;
        END IF;
        UPDATE resumes SET
            label = p_label,
            variant = p_variant,
            resume_text = p_resume_text,
            resume_filename = p_resume_filename,
            is_default = v_make_default
        WHERE id = p_id AND user_id = p_user_id
        RETURNING * INTO v_row;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'upsert_resume_variant: resume % not found', p_id;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_row.id,
        'is_default', v_row.is_default,
        'updated_at', v_row.updated_at
    );
END;
$$;

-- set_default_resume — make one variant the default (clears the others).
CREATE OR REPLACE FUNCTION set_default_resume(
    p_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE resumes SET is_default = false
    WHERE user_id = p_user_id AND is_default AND id <> p_id;

    UPDATE resumes SET is_default = true
    WHERE id = p_id AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'set_default_resume: resume % not found', p_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', p_id);
END;
$$;

-- delete_resume — remove a variant; promote another to default if it was one.
CREATE OR REPLACE FUNCTION delete_resume(
    p_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_was_default boolean;
BEGIN
    DELETE FROM resumes
    WHERE id = p_id AND user_id = p_user_id
    RETURNING is_default INTO v_was_default;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'delete_resume: resume % not found', p_id;
    END IF;

    IF v_was_default THEN
        UPDATE resumes SET is_default = true
        WHERE id = (
            SELECT id FROM resumes WHERE user_id = p_user_id
            ORDER BY created_at LIMIT 1
        );
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================================================
-- ROLE FIT  (the AI-judge read of each resume against a posting)
-- ============================================================================

-- get_role_fit — a posting + every resume's fit judgement, plus which resume
-- is recommended (highest alignment). Powers the role fit page.
CREATE OR REPLACE FUNCTION get_role_fit(
    p_job_posting_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'posting', (
            SELECT to_jsonb(x) FROM (
                SELECT jp.id, jp.title, jp.url, jp.location, jp.remote_policy,
                       jp.salary_min, jp.salary_max, jp.requirements, jp.nice_to_haves,
                       jp.experience_alignment, jp.career_trajectory, jp.growth_stage,
                       jp.role_type, jp.closed_at, jp.closed_reason,
                       o.id AS organization_id, o.name AS organization_name
                FROM job_postings jp
                JOIN organizations o ON o.id = jp.organization_id
                WHERE jp.id = p_job_posting_id AND jp.user_id = p_user_id
            ) x
        ),
        'resumes', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'resume_id', r.id,
                    'label', r.label,
                    'variant', r.variant,
                    'is_default', r.is_default,
                    'fit', (
                        SELECT to_jsonb(f) FROM (
                            SELECT rf.alignment, rf.summary, rf.spikes, rf.gaps,
                                   rf.tweaks, rf.model, rf.judged_at
                            FROM role_fit rf
                            WHERE rf.resume_id = r.id
                              AND rf.job_posting_id = p_job_posting_id
                        ) f
                    )
                ) ORDER BY r.is_default DESC, r.created_at
            ), '[]'::jsonb)
            FROM resumes r WHERE r.user_id = p_user_id
        ),
        'recommended_resume_id', (
            SELECT rf.resume_id FROM role_fit rf
            WHERE rf.job_posting_id = p_job_posting_id
              AND rf.user_id = p_user_id
              AND rf.alignment IS NOT NULL
            ORDER BY rf.alignment DESC, rf.judged_at DESC
            LIMIT 1
        ),
        -- The career-trajectory judge's read of THIS posting (null until judged).
        'career', (
            SELECT to_jsonb(c) FROM (
                SELECT cj.trajectory, cj.confidence, cj.deltas, cj.rationale,
                       cj.model, cj.judged_at
                FROM career_judgment cj
                WHERE cj.job_posting_id = p_job_posting_id AND cj.user_id = p_user_id
            ) c
        ),
        -- The growth judge's read of this posting's COMPANY (cached on the org).
        'growth', (
            SELECT to_jsonb(g) FROM (
                SELECT jp.growth_stage AS stage, o.growth_signals AS signals,
                       o.growth_sources AS sources, o.growth_confidence AS confidence,
                       o.growth_rationale AS rationale, o.growth_model AS model,
                       o.growth_judged_at AS judged_at
                FROM job_postings jp
                JOIN organizations o ON o.id = jp.organization_id
                WHERE jp.id = p_job_posting_id AND jp.user_id = p_user_id
            ) g
        )
    );
$$;

-- get_fit_coverage — every posting with the set of resume_ids already judged
-- against it. Powers the backfill button (postings with an empty set are
-- un-judged) and per-resume targeting (postings missing a given resume_id).
CREATE OR REPLACE FUNCTION get_fit_coverage(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'postings', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', jp.id,
                    'title', jp.title,
                    'organization_name', o.name,
                    'judged_resume_ids', COALESCE((
                        SELECT jsonb_agg(rf.resume_id)
                        FROM role_fit rf
                        WHERE rf.job_posting_id = jp.id
                          AND rf.user_id = p_user_id
                          AND rf.alignment IS NOT NULL
                    ), '[]'::jsonb)
                ) ORDER BY o.name, jp.title
            )
            FROM job_postings jp
            JOIN organizations o ON o.id = jp.organization_id
            WHERE jp.user_id = p_user_id
              AND jp.closed_at IS NULL              -- closed roles drop off
        ), '[]'::jsonb)
    );
$$;

-- get_resume_feedback — the inverse cut of get_role_fit: every judge read for
-- ONE resume, rolled up across all the roles it's been scored against. Powers
-- the Resumes-tab feedback digest so the proposed tweaks can be worked in one
-- place. Newest judgement first; only rows that were actually judged
-- (alignment IS NOT NULL) are included.
CREATE OR REPLACE FUNCTION get_resume_feedback(
    p_resume_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'resume_id', p_resume_id,
        'roles', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'posting_id', jp.id,
                    'title', jp.title,
                    'organization_name', o.name,
                    'alignment', rf.alignment,
                    'summary', rf.summary,
                    'spikes', rf.spikes,
                    'gaps', rf.gaps,
                    'tweaks', rf.tweaks,
                    'model', rf.model,
                    'judged_at', rf.judged_at
                ) ORDER BY rf.judged_at DESC
            )
            FROM role_fit rf
            JOIN job_postings jp ON jp.id = rf.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE rf.resume_id = p_resume_id
              AND rf.user_id = p_user_id
              AND rf.alignment IS NOT NULL
        ), '[]'::jsonb),
        -- The cached cross-role synthesis (null until synthesize-feedback runs).
        -- source_count lets the UI flag it stale when newer judgements exist.
        'synthesis', (
            SELECT to_jsonb(s) FROM (
                SELECT fs.themes, fs.headline, fs.source_count, fs.model,
                       fs.synthesized_at, fs.manual_order
                FROM resume_feedback_synthesis fs
                WHERE fs.resume_id = p_resume_id AND fs.user_id = p_user_id
            ) s
        )
    );
$$;

-- save_resume_synthesis — cache the synthesize-feedback judge's ranked, bucketed
-- themes for one resume (one row per resume, overwritten each run). Called by the
-- synthesize-feedback edge function (service_role, passes p_user_id).
CREATE OR REPLACE FUNCTION save_resume_synthesis(
    p_resume_id uuid,
    p_themes jsonb,
    p_headline text DEFAULT NULL,
    p_source_count int DEFAULT NULL,
    p_model text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_resume_synthesis: no user_id';
    END IF;
    -- ownership: the resume must belong to the caller
    IF NOT EXISTS (SELECT 1 FROM resumes WHERE id = p_resume_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'save_resume_synthesis: resume % not found', p_resume_id;
    END IF;

    INSERT INTO resume_feedback_synthesis (resume_id, user_id, themes, headline,
                                           source_count, model, synthesized_at)
    VALUES (p_resume_id, p_user_id, p_themes, p_headline, p_source_count, p_model, now())
    ON CONFLICT (resume_id) DO UPDATE SET
        themes         = EXCLUDED.themes,
        headline       = EXCLUDED.headline,
        source_count   = EXCLUDED.source_count,
        model          = EXCLUDED.model,
        synthesized_at = now(),
        -- a fresh synthesis comes value-ranked; drop any prior hand-ordering so
        -- the panel re-sorts by the model's priority until re-ordered again.
        manual_order   = false;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- save_role_fit — upsert one (posting × resume) judgement AND lift the posting's
-- experience_alignment to the best fit across resumes, so compute_priority's
-- force-ranking reflects the judge instead of the neutral 0.5 fallback.
-- Called by the judge-fit edge function (service_role, passes p_user_id).
CREATE OR REPLACE FUNCTION save_role_fit(
    p_job_posting_id uuid,
    p_resume_id uuid,
    p_alignment numeric,
    p_summary text DEFAULT NULL,
    p_spikes jsonb DEFAULT NULL,
    p_gaps jsonb DEFAULT NULL,
    p_tweaks jsonb DEFAULT NULL,
    p_model text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_best numeric;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_role_fit: no user_id';
    END IF;

    INSERT INTO role_fit (user_id, job_posting_id, resume_id, alignment,
                          summary, spikes, gaps, tweaks, model, judged_at)
    VALUES (p_user_id, p_job_posting_id, p_resume_id, p_alignment,
            p_summary, p_spikes, p_gaps, p_tweaks, p_model, now())
    ON CONFLICT (job_posting_id, resume_id) DO UPDATE SET
        alignment = EXCLUDED.alignment,
        summary = EXCLUDED.summary,
        spikes = EXCLUDED.spikes,
        gaps = EXCLUDED.gaps,
        tweaks = EXCLUDED.tweaks,
        model = EXCLUDED.model,
        judged_at = now();

    SELECT max(alignment) INTO v_best FROM role_fit
    WHERE job_posting_id = p_job_posting_id AND user_id = p_user_id;

    UPDATE job_postings SET experience_alignment = v_best
    WHERE id = p_job_posting_id AND user_id = p_user_id;

    RETURN jsonb_build_object('success', true, 'experience_alignment', v_best);
END;
$$;


-- ============================================================================
-- CAREER TRAJECTORY  (the career_trajectory input — see priority_score.yaml)
-- judge-career reads the JD against career_profile (baseline + ambition) and
-- writes its verdict here; save_career_judgment lifts the enum onto the posting.
-- ============================================================================

-- get_career_profile — the user's baseline + ambition vector (one row, or an
-- empty shell). judge-career reads this so step_up/lateral is personal, not a
-- guess from the title; the Profile page edits it.
CREATE OR REPLACE FUNCTION get_career_profile(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'has_profile', (cp.user_id IS NOT NULL),
        'profile', to_jsonb(cp)
    )
    FROM (SELECT p_user_id AS uid) base
    LEFT JOIN career_profile cp ON cp.user_id = base.uid;
$$;

-- save_career_profile — upsert the whole profile (one row per user). Every field
-- is overwritten with the value passed (the editor always sends the full form).
CREATE OR REPLACE FUNCTION save_career_profile(
    p_current_title text DEFAULT NULL,
    p_current_level text DEFAULT NULL,
    p_current_track text DEFAULT NULL,
    p_current_span int DEFAULT NULL,
    p_years_experience numeric DEFAULT NULL,
    p_current_comp int DEFAULT NULL,
    p_primary_domain text DEFAULT NULL,
    p_target_track text DEFAULT NULL,
    p_target_level text DEFAULT NULL,
    p_target_comp_floor int DEFAULT NULL,
    p_forward_means text[] DEFAULT NULL,
    p_lateral_domains text[] DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_career_profile: no user_id';
    END IF;

    INSERT INTO career_profile (
        user_id, current_title, current_level, current_track, current_span,
        years_experience, current_comp, primary_domain, target_track,
        target_level, target_comp_floor, forward_means, lateral_domains, notes
    ) VALUES (
        p_user_id, p_current_title, p_current_level, p_current_track, p_current_span,
        p_years_experience, p_current_comp, p_primary_domain, p_target_track,
        p_target_level, p_target_comp_floor, p_forward_means, p_lateral_domains, p_notes
    )
    ON CONFLICT (user_id) DO UPDATE SET
        current_title     = EXCLUDED.current_title,
        current_level     = EXCLUDED.current_level,
        current_track     = EXCLUDED.current_track,
        current_span      = EXCLUDED.current_span,
        years_experience  = EXCLUDED.years_experience,
        current_comp      = EXCLUDED.current_comp,
        primary_domain    = EXCLUDED.primary_domain,
        target_track      = EXCLUDED.target_track,
        target_level      = EXCLUDED.target_level,
        target_comp_floor = EXCLUDED.target_comp_floor,
        forward_means     = EXCLUDED.forward_means,
        lateral_domains   = EXCLUDED.lateral_domains,
        notes             = EXCLUDED.notes;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- save_career_judgment — upsert one posting's career read AND lift the enum onto
-- job_postings.career_trajectory, so compute_priority's force-ranking reflects
-- the judge instead of the neutral 0.5 fallback. Called by judge-career
-- (service_role, passes p_user_id).
CREATE OR REPLACE FUNCTION save_career_judgment(
    p_job_posting_id uuid,
    p_trajectory text,
    p_confidence numeric DEFAULT NULL,
    p_deltas jsonb DEFAULT NULL,
    p_rationale text DEFAULT NULL,
    p_model text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_career_judgment: no user_id';
    END IF;

    INSERT INTO career_judgment (user_id, job_posting_id, trajectory, confidence,
                                 deltas, rationale, model, judged_at)
    VALUES (p_user_id, p_job_posting_id, p_trajectory, p_confidence,
            p_deltas, p_rationale, p_model, now())
    ON CONFLICT (job_posting_id) DO UPDATE SET
        trajectory = EXCLUDED.trajectory,
        confidence = EXCLUDED.confidence,
        deltas     = EXCLUDED.deltas,
        rationale  = EXCLUDED.rationale,
        model      = EXCLUDED.model,
        judged_at  = now();

    UPDATE job_postings SET career_trajectory = p_trajectory
    WHERE id = p_job_posting_id AND user_id = p_user_id;

    RETURN jsonb_build_object('success', true, 'career_trajectory', p_trajectory);
END;
$$;


-- ============================================================================
-- GROWTH STAGE  (the growth_stage input — see priority_score.yaml)
-- Growth is a COMPANY property: judge-growth fetches external signals once per
-- company and caches them on organizations; save_growth_judgment lifts the stage
-- enum onto EVERY one of that company's postings owned by the user.
-- ============================================================================

-- save_growth_judgment — cache the company's growth signals on the org and write
-- the stage to all the user's postings at that org. Called by judge-growth
-- (service_role, passes p_user_id). p_organization_id is verified to be one the
-- user actually has a posting for, so a caller can't scribble on arbitrary orgs.
CREATE OR REPLACE FUNCTION save_growth_judgment(
    p_organization_id uuid,
    p_stage text,
    p_confidence numeric DEFAULT NULL,
    p_signals jsonb DEFAULT NULL,
    p_sources jsonb DEFAULT NULL,
    p_rationale text DEFAULT NULL,
    p_model text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_owned boolean;
    v_count int;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_growth_judgment: no user_id';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM job_postings
        WHERE organization_id = p_organization_id AND user_id = p_user_id
    ) INTO v_owned;
    IF NOT v_owned THEN
        RAISE EXCEPTION 'save_growth_judgment: org % not in your search', p_organization_id;
    END IF;

    UPDATE organizations SET
        growth_signals    = p_signals,
        growth_sources    = p_sources,
        growth_confidence = p_confidence,
        growth_rationale  = p_rationale,
        growth_model      = p_model,
        growth_judged_at  = now()
    WHERE id = p_organization_id;

    UPDATE job_postings SET growth_stage = p_stage
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'growth_stage', p_stage,
                              'postings_updated', v_count);
END;
$$;


-- ============================================================================
-- ANALYTICS  (the signal map — powers the Insights scatter + signal backfill)
-- ============================================================================

-- get_roles_analytics — every posting with the three judged signals, the derived
-- priority components (compute_priority, with neutral 0.5 fallbacks), raw comp +
-- location for plotting, and per-signal "judged yet?" flags. One read backs both
-- the Insights fit-vs-(career+growth) scatter and the "judge career + growth for
-- all roles" backfill (which targets the rows whose flags are false).
CREATE OR REPLACE FUNCTION get_roles_analytics(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'roles', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'posting_id', jp.id,
                    'title', jp.title,
                    'organization_id', o.id,
                    'organization_name', o.name,
                    'location', jp.location,
                    'remote_policy', jp.remote_policy,
                    'salary_min', jp.salary_min,
                    'salary_max', jp.salary_max,
                    'experience_alignment', jp.experience_alignment,
                    'career_trajectory', jp.career_trajectory,
                    'growth_stage', jp.growth_stage,
                    'priority', compute_priority(
                        jp.experience_alignment, jp.location, jp.remote_policy,
                        jp.salary_min, jp.salary_max, jp.career_trajectory,
                        jp.growth_stage),
                    'application_status', (
                        SELECT a.status FROM applications a
                        WHERE a.job_posting_id = jp.id AND a.status <> 'draft'
                        ORDER BY a.applied_date DESC NULLS LAST LIMIT 1
                    ),
                    'has_fit', EXISTS (
                        SELECT 1 FROM role_fit rf
                        WHERE rf.job_posting_id = jp.id AND rf.user_id = p_user_id
                          AND rf.alignment IS NOT NULL
                    ),
                    'has_career', EXISTS (
                        SELECT 1 FROM career_judgment cj
                        WHERE cj.job_posting_id = jp.id AND cj.user_id = p_user_id
                    ),
                    'has_growth', (o.growth_judged_at IS NOT NULL)
                ) ORDER BY o.name, jp.title
            )
            FROM job_postings jp
            JOIN organizations o ON o.id = jp.organization_id
            WHERE jp.user_id = p_user_id
              AND jp.closed_at IS NULL              -- closed roles drop off
        ), '[]'::jsonb)
    );
$$;


-- ============================================================================
-- BUILDABLE RESUME  (bullet library + JD-targeted assembly — migration 010)
-- ============================================================================

-- list_bullets — the whole library, section-grouped order then manual sort_order.
CREATE OR REPLACE FUNCTION list_bullets(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'bullets', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', b.id,
                'section', b.section,
                'org_label', b.org_label,
                'text', b.text,
                'tags', b.tags,
                'sort_order', b.sort_order,
                'is_active', b.is_active,
                'source', b.source,
                'updated_at', b.updated_at
            ) ORDER BY b.section, b.sort_order, b.created_at
        ), '[]'::jsonb)
    )
    FROM resume_bullets b
    WHERE b.user_id = p_user_id;
$$;

-- upsert_bullet — create (p_id NULL) or update one library bullet. New bullets
-- append to the end of their section (max sort_order + 1) unless one is given.
CREATE OR REPLACE FUNCTION upsert_bullet(
    p_section text,
    p_text text,
    p_org_label text DEFAULT NULL,
    p_tags text[] DEFAULT '{}',
    p_sort_order numeric DEFAULT NULL,
    p_is_active boolean DEFAULT true,
    p_source text DEFAULT 'manual',
    p_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_row resume_bullets;
    v_order numeric;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'upsert_bullet: no user_id';
    END IF;

    IF p_id IS NULL THEN
        v_order := COALESCE(
            p_sort_order,
            (SELECT COALESCE(max(sort_order), 0) + 1 FROM resume_bullets
             WHERE user_id = p_user_id AND section = p_section)
        );
        INSERT INTO resume_bullets (user_id, section, org_label, text, tags,
                                    sort_order, is_active, source)
        VALUES (p_user_id, p_section, p_org_label, p_text, COALESCE(p_tags, '{}'),
                v_order, COALESCE(p_is_active, true), COALESCE(p_source, 'manual'))
        RETURNING * INTO v_row;
    ELSE
        UPDATE resume_bullets SET
            section    = p_section,
            org_label  = p_org_label,
            text       = p_text,
            tags       = COALESCE(p_tags, tags),
            sort_order = COALESCE(p_sort_order, sort_order),
            is_active  = COALESCE(p_is_active, is_active)
        WHERE id = p_id AND user_id = p_user_id
        RETURNING * INTO v_row;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'upsert_bullet: bullet % not found', p_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', v_row.id);
END;
$$;

-- delete_bullet — remove one library bullet.
CREATE OR REPLACE FUNCTION delete_bullet(
    p_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM resume_bullets WHERE id = p_id AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'delete_bullet: bullet % not found', p_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'id', p_id);
END;
$$;

-- reorder_bullets — set sort_order from array position (drag-to-reorder). Only
-- the caller's bullets are touched; ids not owned are ignored.
CREATE OR REPLACE FUNCTION reorder_bullets(
    p_ids uuid[],
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'reorder_bullets: no user_id';
    END IF;
    UPDATE resume_bullets b
    SET sort_order = pos.ord
    FROM (SELECT id, ordinality AS ord FROM unnest(p_ids) WITH ORDINALITY AS t(id, ordinality)) pos
    WHERE b.id = pos.id AND b.user_id = p_user_id;
    RETURN jsonb_build_object('success', true);
END;
$$;

-- save_synthesis_order — persist a hand-reorder (and any edits) of a resume's
-- synthesis themes WITHOUT re-running the judge. Flags manual_order so the UI
-- renders the stored array order instead of re-sorting by the model's priority.
CREATE OR REPLACE FUNCTION save_synthesis_order(
    p_resume_id uuid,
    p_themes jsonb,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_synthesis_order: no user_id';
    END IF;
    UPDATE resume_feedback_synthesis
    SET themes = p_themes, manual_order = true
    WHERE resume_id = p_resume_id AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'save_synthesis_order: no synthesis for resume %', p_resume_id;
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;

-- get_assembled_resume — the current AI-built one-pager for a posting (or null).
CREATE OR REPLACE FUNCTION get_assembled_resume(
    p_job_posting_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'assembled', (
            SELECT to_jsonb(a) FROM (
                SELECT ar.job_posting_id, ar.base_resume_id, ar.body_md,
                       ar.selected_bullet_ids, ar.rationale, ar.model, ar.generated_at
                FROM assembled_resumes ar
                WHERE ar.job_posting_id = p_job_posting_id AND ar.user_id = p_user_id
            ) a
        )
    );
$$;

-- save_assembled_resume — upsert the one-pager for a posting (one row per
-- posting; regenerate overwrites). Called by the assemble-resume edge function
-- (service_role, passes p_user_id) and by the UI when the user edits the draft.
CREATE OR REPLACE FUNCTION save_assembled_resume(
    p_job_posting_id uuid,
    p_body_md text,
    p_selected_bullet_ids jsonb DEFAULT NULL,
    p_rationale text DEFAULT NULL,
    p_base_resume_id uuid DEFAULT NULL,
    p_model text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_assembled_resume: no user_id';
    END IF;
    -- ownership: the posting must belong to the caller
    IF NOT EXISTS (SELECT 1 FROM job_postings WHERE id = p_job_posting_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'save_assembled_resume: posting % not found', p_job_posting_id;
    END IF;

    -- Optional fields default to "keep existing" so a manual body edit (which
    -- passes only p_body_md) doesn't wipe the generation's rationale/selection.
    INSERT INTO assembled_resumes (job_posting_id, user_id, base_resume_id, body_md,
                                   selected_bullet_ids, rationale, model, generated_at)
    VALUES (p_job_posting_id, p_user_id, p_base_resume_id, p_body_md,
            p_selected_bullet_ids, p_rationale, p_model, now())
    ON CONFLICT (job_posting_id) DO UPDATE SET
        base_resume_id      = COALESCE(EXCLUDED.base_resume_id, assembled_resumes.base_resume_id),
        body_md             = EXCLUDED.body_md,
        selected_bullet_ids = COALESCE(EXCLUDED.selected_bullet_ids, assembled_resumes.selected_bullet_ids),
        rationale           = COALESCE(EXCLUDED.rationale, assembled_resumes.rationale),
        model               = COALESCE(EXCLUDED.model, assembled_resumes.model),
        generated_at        = now();

    RETURN jsonb_build_object('success', true, 'job_posting_id', p_job_posting_id);
END;
$$;


-- ============================================================================
-- Grants — both planes. `authenticated` = the SPA's logged-in user (RLS
-- scopes them); `service_role` = the MCP edge function.
-- ============================================================================
GRANT EXECUTE ON FUNCTION get_funnel_metrics(int, uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_action_queue(uuid, int, int, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compute_priority(numeric, text, text, int, int, text, text, jsonb, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION resolve_priority_weights(uuid)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_priority_weights(uuid)                           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_priority_weights(numeric, numeric, numeric, numeric, numeric, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_prioritized_roles(uuid, int, int, jsonb, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION intake_role(text, text, text, int, int, text, text[], text[], text, text, text, date, date, text, numeric, text, text, text[], uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION submit_application(uuid, uuid, text, date, text, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION advance_application(uuid, text, date, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_priority_signals(uuid, numeric, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION close_role(uuid, text, uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION reopen_role(uuid, uuid)                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_resume(uuid)                          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION upsert_resume(text, text, uuid)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION list_resumes(uuid)                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION upsert_resume_variant(text, text, text, text, uuid, boolean, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_default_resume(uuid, uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_resume(uuid, uuid)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_role_fit(uuid, uuid)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_fit_coverage(uuid)                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_resume_feedback(uuid, uuid)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_resume_synthesis(uuid, jsonb, text, int, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_role_fit(uuid, uuid, numeric, text, jsonb, jsonb, jsonb, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_career_profile(uuid)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_career_profile(text, text, text, int, numeric, int, text, text, text, int, text[], text[], text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_career_judgment(uuid, text, numeric, jsonb, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_growth_judgment(uuid, text, numeric, jsonb, jsonb, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_roles_analytics(uuid)               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION list_bullets(uuid)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION upsert_bullet(text, text, text, text[], numeric, boolean, text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_bullet(uuid, uuid)               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION reorder_bullets(uuid[], uuid)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_synthesis_order(uuid, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_assembled_resume(uuid, uuid)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_assembled_resume(uuid, text, jsonb, text, uuid, text, uuid) TO authenticated, service_role;
