-- Migration 004 — resume variants dim + per-role fit judgements
-- ============================================================================
-- Replaces the single-row job_search_profile with a `resumes` dim (one row per
-- variant — e.g. a senior-IC resume and a manager resume) and adds `role_fit`,
-- a fact table holding the AI judge's read of each resume against each posting
-- (alignment 0..1, summary, spikes/gaps, proposed tweaks).
--
-- Why: the dashboard needs to (1) hold two resumes and recommend one per role,
-- and (2) show "what spikes and what doesn't" for a specific role. The judge
-- (judge-fit edge function) writes role_fit rows and, via save_role_fit(), lifts
-- job_postings.experience_alignment to the best fit so the existing priority
-- force-ranking (compute_priority) keeps working unchanged.
--
-- The list_resumes / upsert_resume_variant / get_role_fit / save_role_fit
-- functions live in functions.sql (CREATE OR REPLACE) — re-run it after this.
-- get_resume / upsert_resume are kept as back-compat shims over the default
-- resume so the MCP and the old Profile page keep working.
--
-- Idempotent. For fresh installs these tables are already in schema.sql.
-- ============================================================================

-- ── resumes (dim) ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    label TEXT NOT NULL,                         -- "Senior IC", "Manager"
    variant TEXT CHECK (variant IN ('ic', 'manager', 'other') OR variant IS NULL),
    resume_text TEXT,
    resume_filename TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,   -- the one get_resume()/MCP reads
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id);
-- at most one default per user
CREATE UNIQUE INDEX IF NOT EXISTS uniq_resumes_one_default
    ON resumes(user_id) WHERE is_default;

-- ── role_fit (fact: one judgement per posting × resume) ──────────────────────
CREATE TABLE IF NOT EXISTS role_fit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    resume_id UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,

    alignment NUMERIC(3,2)                       -- 0..1, the judge's fit score
        CHECK ((alignment BETWEEN 0 AND 1) OR alignment IS NULL),
    summary TEXT,                                -- resume-vs-JD summary
    spikes JSONB,                                -- what clearly clears the bar
    gaps JSONB,                                  -- what doesn't
    tweaks JSONB,                                -- proposed edits (human + ATS)
    model TEXT,                                  -- which model judged
    judged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (job_posting_id, resume_id)
);

CREATE INDEX IF NOT EXISTS idx_role_fit_user ON role_fit(user_id);
CREATE INDEX IF NOT EXISTS idx_role_fit_posting ON role_fit(job_posting_id);

-- ── triggers ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS update_resumes_updated_at ON resumes;
CREATE TRIGGER update_resumes_updated_at
    BEFORE UPDATE ON resumes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_role_fit_updated_at ON role_fit;
CREATE TRIGGER update_role_fit_updated_at
    BEFORE UPDATE ON role_fit
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_fit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resumes_user_policy ON resumes;
CREATE POLICY resumes_user_policy ON resumes
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS role_fit_user_policy ON role_fit;
CREATE POLICY role_fit_user_policy ON role_fit
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── one-time data migration: existing single resume → default IC variant ─────
-- Only runs when the user has a job_search_profile resume and no resumes yet.
INSERT INTO resumes (user_id, label, variant, resume_text, resume_filename, is_default)
SELECT p.user_id, 'Senior IC', 'ic', p.resume_text, p.resume_filename, true
FROM job_search_profile p
WHERE p.resume_text IS NOT NULL
  AND length(trim(p.resume_text)) > 0
  AND NOT EXISTS (SELECT 1 FROM resumes r WHERE r.user_id = p.user_id);
