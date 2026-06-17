-- Migration 010 — buildable resume: bullet library + JD-targeted assembly
-- ============================================================================
-- Turns the resume page from "one freeform text blob per variant" into a
-- composable system:
--
--   1. resume_bullets — a library of reusable, tagged, orderable bullets (the
--      raw material). Each belongs to a section (Summary / Experience / Skills /
--      …) and optionally an org_label (which job it describes). Provenance is
--      tracked (manual vs promoted from a synthesis theme or a judge tweak).
--
--   2. assembled_resumes — one AI-built one-page resume per job posting: the
--      assemble-resume edge function scores the library against the JD, picks +
--      orders the best bullets per section, and writes a markdown draft you then
--      edit. One row per posting (regenerate overwrites).
--
--   3. resume_feedback_synthesis.manual_order — lets the synthesize-feedback
--      themes be hand-reordered (the array order becomes canonical) instead of
--      always re-sorting by the model's priority. save_synthesis_order persists
--      a reorder without re-running the judge.
--
-- Functions live in functions.sql too (CREATE OR REPLACE) — re-run it after this.
-- Inlined here so the migration applies standalone. Additive + idempotent.
-- ============================================================================

-- ── 1. bullet library ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resume_bullets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    section     TEXT NOT NULL,                       -- 'Summary' | 'Experience' | 'Skills' | 'Education' | 'Other'
    org_label   TEXT,                                -- e.g. "Acme — Staff Engineer" (null for Summary/Skills)
    text        TEXT NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',        -- freeform filters: 'leadership','python','metrics'
    sort_order  NUMERIC NOT NULL DEFAULT 0,          -- manual order within a section
    is_active   BOOLEAN NOT NULL DEFAULT true,       -- exclude from assembly without deleting
    source      TEXT NOT NULL DEFAULT 'manual'       -- 'manual' | 'synthesis' | 'judge'
                CHECK (source IN ('manual','synthesis','judge')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resume_bullets_user ON resume_bullets(user_id);
CREATE INDEX IF NOT EXISTS idx_resume_bullets_section ON resume_bullets(user_id, section);

DROP TRIGGER IF EXISTS update_resume_bullets_updated_at ON resume_bullets;
CREATE TRIGGER update_resume_bullets_updated_at
    BEFORE UPDATE ON resume_bullets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE resume_bullets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resume_bullets_user_policy ON resume_bullets;
CREATE POLICY resume_bullets_user_policy ON resume_bullets
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── 2. assembled one-pagers ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assembled_resumes (
    job_posting_id UUID PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL,
    base_resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL,  -- header/contact source
    body_md        TEXT,                  -- the assembled one-page markdown
    selected_bullet_ids JSONB,            -- ordered [bullet_id, …] the model chose
    rationale      TEXT,                  -- why these bullets, against this JD
    model          TEXT,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assembled_resumes_user ON assembled_resumes(user_id);

DROP TRIGGER IF EXISTS update_assembled_resumes_updated_at ON assembled_resumes;
CREATE TRIGGER update_assembled_resumes_updated_at
    BEFORE UPDATE ON assembled_resumes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE assembled_resumes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assembled_resumes_user_policy ON assembled_resumes;
CREATE POLICY assembled_resumes_user_policy ON assembled_resumes
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── 3. synthesis manual ordering ─────────────────────────────────────────────
ALTER TABLE resume_feedback_synthesis
    ADD COLUMN IF NOT EXISTS manual_order BOOLEAN NOT NULL DEFAULT false;

-- (RPCs: list_bullets / upsert_bullet / delete_bullet / reorder_bullets /
--  get_assembled_resume / save_assembled_resume / save_synthesis_order —
--  definitions + GRANTs are in functions.sql.)
