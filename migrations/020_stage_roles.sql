-- 020_stage_roles.sql
-- ============================================================================
-- New function: get_stage_roles — the Dashboard's Stage funnel tile drill-down.
-- semantic/metrics/stage_roles.yaml
--
-- Mirrors get_funnel_metrics' reached-based population (pass_through.<stage>.
-- total_ever): every application that EVER reached a stage, not just the ones
-- currently sitting there — so an app now interviewing still lists under
-- 'applied' and 'screening' too, and each stage's row count matches the
-- existing Total column exactly.
--
-- Per role: interviews completed, interviews still scheduled, the furthest
-- round reached (interview_type of the chronologically-last completed/
-- scheduled interview), days since applied, and days since first reached
-- 'screening' (null if the app never got there).
--
-- Re-runnable. Mirrored in functions.sql (canonical).
-- ============================================================================

CREATE OR REPLACE FUNCTION get_stage_roles(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH reached AS (
        -- every (application, stage) pair the app EVER reached — mirrors
        -- get_funnel_metrics' hist/stage_counts population.
        SELECT application_id, to_status AS stage, MIN(changed_at) AS reached_at
        FROM application_status_history
        WHERE user_id = p_user_id
          AND to_status IN ('applied', 'screening', 'interviewing', 'offer')
        GROUP BY application_id, to_status
    ),
    applied_at AS (
        SELECT application_id, reached_at AS applied_at FROM reached WHERE stage = 'applied'
    ),
    screen_at AS (
        SELECT application_id, reached_at AS screen_at FROM reached WHERE stage = 'screening'
    ),
    -- per-application interview rollup: completed / still-scheduled counts, plus
    -- the furthest round reached (the type of the chronologically-last interview
    -- that happened or is on the books; cancelled/no_show don't count as "reached").
    iv AS (
        SELECT
            application_id,
            count(*) FILTER (WHERE status = 'completed') AS completed,
            count(*) FILTER (WHERE status = 'scheduled')  AS pending,
            (array_agg(interview_type ORDER BY scheduled_at DESC NULLS LAST)
                FILTER (WHERE status IN ('completed', 'scheduled')))[1] AS furthest_round
        FROM interviews
        WHERE user_id = p_user_id
        GROUP BY application_id
    ),
    rows AS (
        SELECT
            r.stage,
            a.id AS application_id,
            jp.id AS job_posting_id,
            jp.title,
            o.name AS organization_name,
            COALESCE(iv.completed, 0) AS interviews_completed,
            COALESCE(iv.pending, 0)   AS interviews_pending,
            iv.furthest_round,
            floor(EXTRACT(EPOCH FROM (now() - aa.applied_at)) / 86400.0)::int AS days_since_applied,
            CASE WHEN sa.screen_at IS NOT NULL
                 THEN floor(EXTRACT(EPOCH FROM (now() - sa.screen_at)) / 86400.0)::int
                 ELSE NULL END AS days_since_screen
        FROM reached r
        JOIN applications a  ON a.id = r.application_id
        JOIN job_postings jp ON jp.id = a.job_posting_id
        JOIN organizations o ON o.id = jp.organization_id
        LEFT JOIN iv         ON iv.application_id = a.id
        LEFT JOIN applied_at aa ON aa.application_id = a.id
        LEFT JOIN screen_at  sa ON sa.application_id = a.id
        WHERE a.user_id = p_user_id
    )
    SELECT jsonb_build_object(
        'success', true,
        -- { <stage>: [ {application_id, job_posting_id, title, organization_name,
        --               interviews_completed, interviews_pending, furthest_round,
        --               days_since_applied, days_since_screen}, ... ] }
        'roles', COALESCE((
            SELECT jsonb_object_agg(stage, roles)
            FROM (
                SELECT stage, jsonb_agg(jsonb_build_object(
                    'application_id', application_id,
                    'job_posting_id', job_posting_id,
                    'title', title,
                    'organization_name', organization_name,
                    'interviews_completed', interviews_completed,
                    'interviews_pending', interviews_pending,
                    'furthest_round', furthest_round,
                    'days_since_applied', days_since_applied,
                    'days_since_screen', days_since_screen
                ) ORDER BY days_since_applied DESC NULLS LAST) AS roles
                FROM rows
                GROUP BY stage
            ) g
        ), '{}'::jsonb)
    ) INTO result;

    RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_stage_roles(uuid) TO authenticated, service_role;
