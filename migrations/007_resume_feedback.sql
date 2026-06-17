-- Migration 007 — resume feedback digest + cross-role synthesis
-- ============================================================================
-- Two reads over the existing role_fit fact, both surfaced on the Resumes tab:
--
--   1. get_resume_feedback() — every judge read for ONE resume, rolled up across
--      all the roles it's been scored against (summary / spikes / gaps / proposed
--      tweaks per role, newest first). The inverse cut of get_role_fit.
--
--   2. resume_feedback_synthesis — a cache for the synthesize-feedback judge,
--      which clusters all of a resume's tweaks into ranked, bucketed THEMES so
--      the highest-value edits surface instead of a flat per-role wall of text.
--      One row per resume; derived data, safe to drop and re-synthesize.
--
-- Why: role_fit stores one judgement per (posting × resume); the only way to see
-- the feedback was the per-posting fit page. Once several judges have run that's
-- too much to parse, so (1) gathers it per-resume and (2) synthesizes it.
--
-- The functions (get_resume_feedback / save_resume_synthesis) and the extended
-- get_resume_feedback that returns the cached synthesis live in functions.sql
-- (CREATE OR REPLACE) — re-run it after this migration. Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS resume_feedback_synthesis (
    resume_id UUID PRIMARY KEY REFERENCES resumes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    themes        JSONB,        -- [{ title, category, priority, role_count, recommendation, rationale, roles }]
    headline      TEXT,         -- one-line "fix this first"
    source_count  INTEGER,      -- # of role_fit rows the synthesis was built from
    model         TEXT,
    synthesized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resume_feedback_synthesis_user ON resume_feedback_synthesis(user_id);

DROP TRIGGER IF EXISTS update_resume_feedback_synthesis_updated_at ON resume_feedback_synthesis;
CREATE TRIGGER update_resume_feedback_synthesis_updated_at
    BEFORE UPDATE ON resume_feedback_synthesis
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE resume_feedback_synthesis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resume_feedback_synthesis_user_policy ON resume_feedback_synthesis;
CREATE POLICY resume_feedback_synthesis_user_policy ON resume_feedback_synthesis
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- (get_resume_feedback / save_resume_synthesis definitions + GRANTs are in functions.sql)
