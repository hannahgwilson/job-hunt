-- Migration 024: the coaching layer — candidate-scoped state behind interview prep
--
-- docs/interview-coach-integration.md. interview_prep_sessions (018) is scoped
-- to ONE interview: intake -> research -> transcript -> synthesis, then it's
-- done. Nothing carries to the next round, so the ninth mock interview knows
-- nothing about the previous eight.
--
-- These five tables are the candidate scope — one search, many rounds. They're
-- the decomposition of the interview-coach skill's coaching_state.md, which is
-- the same object at the other scope:
--
--   coaching_profiles   1 per user   Profile, Resume Analysis, Active Strategy,
--                                    Drill Progression, Coaching Notes
--   coaching_stories    many         Storybank + Story Details
--   coaching_scores     many         Score History (5-dim + self-score)
--   coaching_questions  many         Interview Intelligence -> Question Bank
--   coaching_artifacts  many         per-command output that had no home
--
-- Note coaching_stories vs the existing get_story_cheat_sheet(): that rollup is
-- *derived* from interview_prep_sessions.synthesis and regenerated every read.
-- The storybank is durable — strength score, earned secret, last-used — and
-- outlives the session that produced it. Both can coexist; the cheat sheet is a
-- per-employer view, the storybank is the candidate's actual inventory.
--
-- Same boilerplate as interview_prep_sessions: index, updated_at trigger, RLS
-- policy. After applying, (re)apply functions.sql for the coaching RPCs.
--
-- Deletion behavior is deliberate: interview_id is ON DELETE SET NULL, not
-- CASCADE. Deleting an interview round must not silently delete the scores and
-- stories it produced — the trend is the whole point of this layer.

-- ============================================================================
-- coaching_profiles — who the candidate is and how to coach them
-- ============================================================================
CREATE TABLE IF NOT EXISTS coaching_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,

    track TEXT CHECK (track IN ('quick_prep', 'full_system')),
    target_roles TEXT[],
    seniority_band TEXT,          -- e.g. 'senior', 'staff', 'director'

    -- 1-5, drives delivery only — never the diagnosis. At 5 the skill's
    -- Challenge Protocol activates (references/challenge-protocol.md).
    directness SMALLINT NOT NULL DEFAULT 5 CHECK (directness BETWEEN 1 AND 5),

    timeline TEXT,                -- free text: 'about 3 weeks', 'interviewing now'
    timeline_date DATE,           -- when known; drives the staleness check
    biggest_concern TEXT,

    -- Shapes the entire coaching path — a first-timer needs fundamentals, an
    -- active-but-stalling candidate needs diagnosis, not more drills.
    interview_history TEXT CHECK (interview_history IN
        ('first_time', 'active_not_advancing', 'experienced_rusty')),

    -- When the target represents a function/domain/level change, the transition
    -- IS the primary concern and bridge stories become the priority storybank work.
    career_transition TEXT,
    transition_status TEXT CHECK (transition_status IN
        ('not_developed', 'in_progress', 'strong')),

    -- { positioning_strengths[], likely_concerns[], narrative_gaps[], story_seeds[] }
    resume_analysis JSONB,
    -- { focus, bottleneck_dimension, notes } — set after the first scored round
    active_strategy JSONB,

    drill_stage SMALLINT NOT NULL DEFAULT 1 CHECK (drill_stage BETWEEN 1 AND 5),
    coaching_notes JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array of short strings

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_profiles_user ON coaching_profiles(user_id);

-- ============================================================================
-- coaching_stories — the storybank
-- ============================================================================
CREATE TABLE IF NOT EXISTS coaching_stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,

    title TEXT NOT NULL,
    competency TEXT,              -- the primary competency this story answers

    situation TEXT,
    task TEXT,
    action TEXT,
    result TEXT,

    -- The insight only this candidate could have, from direct experience. This
    -- is what separates a story anyone could tell from one only they can —
    -- the 5th rubric dimension in narrative form.
    earned_secret TEXT,

    strength SMALLINT CHECK (strength BETWEEN 1 AND 5),
    best_for TEXT,                -- secondary competencies / question types
    tags TEXT[],

    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'synthesis', 'mock', 'mcp')),
    source_interview_id UUID REFERENCES interviews(id) ON DELETE SET NULL,

    last_used_at TIMESTAMPTZ,
    use_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Lets synthesis re-run without duplicating the bank: same title upserts.
    UNIQUE (user_id, title)
);

CREATE INDEX IF NOT EXISTS idx_coaching_stories_user ON coaching_stories(user_id);
CREATE INDEX IF NOT EXISTS idx_coaching_stories_competency ON coaching_stories(user_id, competency);

-- ============================================================================
-- coaching_scores — 5-dimension score history
-- ============================================================================
CREATE TABLE IF NOT EXISTS coaching_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    interview_id UUID REFERENCES interviews(id) ON DELETE SET NULL,

    source TEXT NOT NULL CHECK (source IN ('mock', 'practice', 'analyze', 'real')),
    round_label TEXT,             -- 'behavioral round 2', 'practice — conflict'

    -- The skill's core rubric. STAR hasn't gone away — it's the structural
    -- frame inside `structure` — but four more dimensions come with it, and
    -- `differentiation` is the one the app had no equivalent for at all.
    substance SMALLINT CHECK (substance BETWEEN 1 AND 5),
    structure SMALLINT CHECK (structure BETWEEN 1 AND 5),
    relevance SMALLINT CHECK (relevance BETWEEN 1 AND 5),
    credibility SMALLINT CHECK (credibility BETWEEN 1 AND 5),
    differentiation SMALLINT CHECK (differentiation BETWEEN 1 AND 5),

    -- The calibration engine: the gap between what the candidate thought and
    -- what the coach scored is itself a coachable signal.
    self_score SMALLINT CHECK (self_score BETWEEN 1 AND 5),

    root_cause TEXT,
    question TEXT,
    competency TEXT,
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_scores_user ON coaching_scores(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_scores_interview ON coaching_scores(interview_id);

-- ============================================================================
-- coaching_questions — the question bank
-- ============================================================================
CREATE TABLE IF NOT EXISTS coaching_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    interview_id UUID REFERENCES interviews(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    question TEXT NOT NULL,
    competency TEXT,
    question_type TEXT,           -- behavioral | technical | case | culture | ...

    -- How the answer landed, when known. Populated by the feedback stage and
    -- by debriefs; null for questions merely predicted.
    went TEXT CHECK (went IN ('strong', 'solid', 'needs_work', 'weak')),
    source TEXT NOT NULL DEFAULT 'mock' CHECK (source IN ('mock', 'real', 'debrief', 'predicted')),

    asked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_questions_user ON coaching_questions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_questions_org ON coaching_questions(organization_id);

-- ============================================================================
-- coaching_artifacts — generated sheets from the ported command stages
-- ============================================================================
-- One row per (user, kind, interview). `progress` is candidate-scoped and has a
-- NULL interview_id; the rest are per-round. A plain UNIQUE constraint would
-- treat every NULL as distinct and let `progress` rows pile up, so the
-- uniqueness is a COALESCE index instead.
CREATE TABLE IF NOT EXISTS coaching_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    interview_id UUID REFERENCES interviews(id) ON DELETE CASCADE,

    kind TEXT NOT NULL CHECK (kind IN
        ('concerns', 'questions_to_ask', 'hype', 'progress', 'decode')),
    content JSONB NOT NULL,
    model TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coaching_artifacts_unique
    ON coaching_artifacts(
        user_id, kind,
        COALESCE(interview_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

-- ============================================================================
-- updated_at triggers + RLS (same shape as interview_prep_sessions)
-- ============================================================================
DROP TRIGGER IF EXISTS update_coaching_profiles_updated_at ON coaching_profiles;
CREATE TRIGGER update_coaching_profiles_updated_at
    BEFORE UPDATE ON coaching_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_coaching_stories_updated_at ON coaching_stories;
CREATE TRIGGER update_coaching_stories_updated_at
    BEFORE UPDATE ON coaching_stories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_coaching_artifacts_updated_at ON coaching_artifacts;
CREATE TRIGGER update_coaching_artifacts_updated_at
    BEFORE UPDATE ON coaching_artifacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE coaching_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_stories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_scores    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coaching_profiles_user_policy ON coaching_profiles;
CREATE POLICY coaching_profiles_user_policy ON coaching_profiles
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS coaching_stories_user_policy ON coaching_stories;
CREATE POLICY coaching_stories_user_policy ON coaching_stories
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS coaching_scores_user_policy ON coaching_scores;
CREATE POLICY coaching_scores_user_policy ON coaching_scores
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS coaching_questions_user_policy ON coaching_questions;
CREATE POLICY coaching_questions_user_policy ON coaching_questions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS coaching_artifacts_user_policy ON coaching_artifacts;
CREATE POLICY coaching_artifacts_user_policy ON coaching_artifacts
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
