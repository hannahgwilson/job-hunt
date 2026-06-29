-- Migration 014 — human eval labels on judge-fit analyses (the tuning bench)
-- ============================================================================
-- The Tuning Bench page runs the user's résumés against a few JDs and lets them
-- rate each resulting analysis: was the judge's per-requirement tiering right
-- (good/bad), is this the best read among the variants for that JD, and free-text
-- notes on what to fix. That labeled set is the intel for tuning the judge-fit
-- prompt — it's eval data ABOUT the model output, distinct from role_fit (the
-- model output itself) and from resume_feedback_synthesis (advice for the résumé).
--
--   fit_eval — one row per (posting × resume) analysis the user has rated:
--     rating  'good' | 'bad' | NULL   — is the judge's analysis accurate?
--     is_best boolean                 — best analysis for this JD among variants
--     notes   text                    — what the judge got wrong / should weigh
--
-- save_fit_eval / get_fit_evals live in functions.sql, and get_role_fit now
-- returns each resume's eval so the bench (and role page) show prior ratings —
-- re-apply functions.sql after this. Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fit_eval (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    resume_id UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,

    rating TEXT CHECK (rating IN ('good', 'bad')),
    is_best BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (job_posting_id, resume_id)
);

CREATE INDEX IF NOT EXISTS idx_fit_eval_user ON fit_eval(user_id);
CREATE INDEX IF NOT EXISTS idx_fit_eval_posting ON fit_eval(job_posting_id);

DROP TRIGGER IF EXISTS update_fit_eval_updated_at ON fit_eval;
CREATE TRIGGER update_fit_eval_updated_at
    BEFORE UPDATE ON fit_eval
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE fit_eval ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fit_eval_user_policy ON fit_eval;
CREATE POLICY fit_eval_user_policy ON fit_eval
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
