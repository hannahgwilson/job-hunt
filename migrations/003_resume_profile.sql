-- Migration 003 — resume / job-search profile
-- ============================================================================
-- Stores the long-form resume the prioritization framework scores
-- `experience_alignment` against (see semantic/metrics/priority_score.yaml).
-- One row per user; uploaded/pasted from the tracking-hub UI, read by the agent.
--
-- The get_resume / upsert_resume functions live in functions.sql (CREATE OR
-- REPLACE) — re-run it after this migration.
--
-- Idempotent. For fresh installs this table is already in schema.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_search_profile (
    user_id UUID PRIMARY KEY,
    resume_text TEXT,
    resume_filename TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS update_job_search_profile_updated_at ON job_search_profile;
CREATE TRIGGER update_job_search_profile_updated_at
    BEFORE UPDATE ON job_search_profile
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE job_search_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_search_profile_user_policy ON job_search_profile;
CREATE POLICY job_search_profile_user_policy ON job_search_profile
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
