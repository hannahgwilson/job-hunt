-- Migration 002 — prioritization signals on job_postings
-- ============================================================================
-- Adds the three agent-judged inputs that compute_priority() needs to
-- force-rank postings (see semantic/metrics/priority_score.yaml). The other
-- scoring inputs — location, remote_policy, salary_min/max — already exist.
--
-- The scoring FUNCTIONS themselves (compute_priority, get_prioritized_roles,
-- and the updated get_action_queue) live in functions.sql, which is all
-- CREATE OR REPLACE — re-run it after this migration.
--
-- Idempotent. Safe to run against an already-deployed job-hunt schema.
-- For fresh installs these columns are already in schema.sql.
-- ============================================================================

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS experience_alignment NUMERIC(3,2)
        CHECK ((experience_alignment BETWEEN 0 AND 1) OR experience_alignment IS NULL);

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS career_trajectory TEXT
        CHECK (career_trajectory IN ('step_up', 'lateral', 'step_back')
               OR career_trajectory IS NULL);

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS growth_stage TEXT
        CHECK (growth_stage IN ('seed', 'early', 'growth', 'late', 'public', 'unknown')
               OR growth_stage IS NULL);
