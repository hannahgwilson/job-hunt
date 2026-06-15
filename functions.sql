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


-- get_action_queue — the four buckets the search runs on, in one call:
--   roles_to_apply   — tracked postings with no live application
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
        'roles_to_apply', (
            SELECT coalesce(jsonb_agg(
                to_jsonb(jp) || jsonb_build_object(
                    'organization_name', o.name,
                    'closing_soon', (jp.closing_date IS NOT NULL
                                     AND jp.closing_date <= current_date + p_closing_days)
                ) ORDER BY jp.closing_date NULLS LAST, jp.created_at DESC
            ), '[]'::jsonb)
            FROM job_postings jp
            JOIN organizations o ON o.id = jp.organization_id
            WHERE jp.user_id = p_user_id
              AND NOT EXISTS (
                  SELECT 1 FROM applications a
                  WHERE a.job_posting_id = jp.id AND a.status <> 'draft'
              )
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
-- WRITES  (the brittleness fix — multi-step intake in one transaction)
-- ============================================================================

-- intake_role — find-or-create the org, then insert the posting, atomically.
-- Returns the org id (+ whether it was newly created) and the full posting.
-- The OB company/role thought is captured separately by the agent via the
-- open-brain MCP (keeps this function decoupled from the brain's queue schema).
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
        source, posted_date, closing_date, notes
    )
    VALUES (
        p_user_id, v_org_id, p_title, p_url,
        p_salary_min, p_salary_max, coalesce(p_salary_currency, 'USD'),
        coalesce(p_requirements, '{}'), coalesce(p_nice_to_haves, '{}'),
        p_location, p_remote_policy,
        p_source, p_posted_date, p_closing_date, p_notes
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


-- ============================================================================
-- Grants — both planes. `authenticated` = the SPA's logged-in user (RLS
-- scopes them); `service_role` = the MCP edge function.
-- ============================================================================
GRANT EXECUTE ON FUNCTION get_funnel_metrics(int, uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_action_queue(uuid, int, int, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION intake_role(text, text, text, int, int, text, text[], text[], text, text, text, date, date, text, text[], uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION submit_application(uuid, uuid, text, date, text, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION advance_application(uuid, text, date, text, uuid) TO authenticated, service_role;
