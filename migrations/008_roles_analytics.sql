-- Migration 008 — roles analytics (the Insights signal map)
-- ============================================================================
-- Adds get_roles_analytics(): every posting with its three judged signals, the
-- derived priority components, raw comp + location, and per-signal "judged yet?"
-- flags. One read powers both the Insights fit-vs-(career+growth) scatter and the
-- "judge career + growth for all roles" backfill (it targets the un-judged rows).
--
-- No schema change — a pure read over existing tables (job_postings, role_fit,
-- career_judgment, organizations.growth_judged_at). The same definition also
-- lives in functions.sql (the re-runnable logic layer); it's inlined here so this
-- migration applies on its own. Depends on compute_priority() (migration 002).
-- ============================================================================

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
        ), '[]'::jsonb)
    );
$$;

GRANT EXECUTE ON FUNCTION get_roles_analytics(uuid) TO authenticated, service_role;
