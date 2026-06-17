-- Migration 006 — automate the two remaining agent-judged priority signals
-- ============================================================================
-- experience_alignment is already AI-judged (judge-fit → role_fit). This adds
-- the storage behind the other two subjective inputs to compute_priority so they
-- can be judged too (see supabase/functions/JUDGE_SIGNALS_SPEC.md):
--
--   career_trajectory  ← judge-career  (needs a personal baseline → career_profile)
--   growth_stage       ← judge-growth  (needs external company signals → cached on
--                                        organizations, judged per-company)
--
-- The canonical signal columns stay where compute_priority already reads them:
-- job_postings.career_trajectory and job_postings.growth_stage are UNCHANGED.
-- This migration only adds (1) the context a judge needs and (2) somewhere to
-- keep each judge's rationale for display — exactly mirroring how role_fit holds
-- the experience judge's summary/spikes/gaps without touching experience_alignment.
--
-- The RPCs (get_career_profile / save_career_profile / save_career_judgment /
-- save_growth_judgment) and the extended get_role_fit live in functions.sql
-- (CREATE OR REPLACE) — re-run it after this. Additive + idempotent.
-- ============================================================================

-- ── career_profile (dim) ─────────────────────────────────────────────────────
-- One row per user: where they are now + what "forward" means TO THEM. Without
-- it judge-career can only guess seniority from the title; with it the step_up /
-- lateral / step_back call is personal (an IC who wants to stay IC reads a
-- management role as lateral, not a step up).
CREATE TABLE IF NOT EXISTS career_profile (
    user_id UUID PRIMARY KEY,

    -- Baseline: the seat they're in today.
    current_title     TEXT,
    current_level     TEXT,                         -- "Senior", "Staff", "Director"
    current_track     TEXT CHECK (current_track IN ('ic', 'manager') OR current_track IS NULL),
    current_span      INTEGER,                       -- direct reports, if a manager
    years_experience  NUMERIC(4,1),
    current_comp      INTEGER,                        -- total comp, for the comp delta (optional)
    primary_domain    TEXT,                           -- "ML platform", "backend infra"

    -- Ambition vector: what counts as forward.
    target_track      TEXT CHECK (target_track IN ('ic', 'manager', 'either') OR target_track IS NULL),
    target_level      TEXT,
    target_comp_floor INTEGER,
    -- Free-form lists so the judge can weigh them; e.g.
    -- forward_means: {more_scope, more_comp, bigger_company, earlier_stage, more_autonomy}
    forward_means     TEXT[],
    lateral_domains   TEXT[],                         -- domains they'd accept as a sideways pivot
    notes             TEXT,                           -- anything else that defines "forward"

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE career_profile ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS career_profile_user_policy ON career_profile;
CREATE POLICY career_profile_user_policy ON career_profile
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_career_profile_updated_at ON career_profile;
CREATE TRIGGER update_career_profile_updated_at
    BEFORE UPDATE ON career_profile
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── career_judgment (fact) ───────────────────────────────────────────────────
-- One row per posting: the judge's reasoning behind career_trajectory. The
-- trajectory enum itself is written to job_postings.career_trajectory by
-- save_career_judgment (so compute_priority is untouched); this holds the
-- human-facing deltas/rationale, the same split role_fit uses for experience.
CREATE TABLE IF NOT EXISTS career_judgment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,

    trajectory  TEXT CHECK (trajectory IN ('step_up', 'lateral', 'step_back') OR trajectory IS NULL),
    confidence  NUMERIC(3,2) CHECK ((confidence BETWEEN 0 AND 1) OR confidence IS NULL),
    deltas      JSONB,        -- { seniority, scope, comp, track, domain }: up|flat|down|n/a
    rationale   TEXT,
    model       TEXT,
    judged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (job_posting_id)
);

CREATE INDEX IF NOT EXISTS idx_career_judgment_user ON career_judgment(user_id);
CREATE INDEX IF NOT EXISTS idx_career_judgment_posting ON career_judgment(job_posting_id);

ALTER TABLE career_judgment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS career_judgment_user_policy ON career_judgment;
CREATE POLICY career_judgment_user_policy ON career_judgment
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_career_judgment_updated_at ON career_judgment;
CREATE TRIGGER update_career_judgment_updated_at
    BEFORE UPDATE ON career_judgment
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── growth signal cache on the shared organizations dim ──────────────────────
-- Growth is a COMPANY property, so its judged signals are cached here (one fetch
-- per company, reused by every posting at that company) rather than per posting.
-- The stage enum still lands on each posting's job_postings.growth_stage (written
-- by save_growth_judgment) so compute_priority is unchanged. ADD COLUMN IF NOT
-- EXISTS only — organizations is shared; this never drops or rewrites. The judge
-- writes these per-user values; for a single-user search that's the whole story.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_signals    JSONB;   -- {funding_stage,last_round_date,headcount,headcount_trend,total_raised,momentum[],risks[]}
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_sources    JSONB;   -- [urls] the judge cited
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_confidence NUMERIC(3,2);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_rationale  TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_model      TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS growth_judged_at  TIMESTAMPTZ;
