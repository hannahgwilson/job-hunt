-- Extension 6: Job Hunt Pipeline
-- Schema for tracking a job search as facts (applications, status transitions,
-- interviews) layered on the canonical dims (organizations, contacts).
--
-- Design notes
-- ------------
--   * No `companies` table. Target employers live in the shared `organizations`
--     dim (from schemas/organizations). job_postings FK organization_id.
--   * No `job_contacts` table. Recruiters / hiring managers / interviewers
--     live in the shared `contacts` table with tags=['professional','job-hunt']
--     and `organization_id` set. Referenced from applications.referral_contact_id
--     and interviews.interviewer_contact_id.
--   * Application status changes are auto-logged into application_status_history
--     by a trigger. Lets you compute true funnel conversion + time-in-stage
--     without trusting the MCP to remember.
--   * interviews.event_id is a nullable bridge to the `events` table. When set,
--     the interview appears in the family-calendar week schedule alongside
--     other commitments.
--
-- Dependencies
-- ------------
--   * organizations table (schemas/organizations)
--   * contacts table (extensions/family-calendar) -- with .organization_id FK
--     added by schemas/organizations
--   * events table (extensions/family-calendar) -- optional, only for the
--     interview-to-calendar bridge

-- ============================================================================
-- job_postings
-- A specific role at an organization. Descriptive dim; one row per posting,
-- many applications may FK back if you re-apply.
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_postings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    title TEXT NOT NULL,
    url TEXT,

    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',

    requirements TEXT[],
    nice_to_haves TEXT[],

    location TEXT,               -- posting-specific location; may differ from org HQ
    remote_policy TEXT CHECK (remote_policy IN ('remote', 'hybrid', 'onsite') OR remote_policy IS NULL),

    source TEXT CHECK (source IN ('linkedin', 'company-site', 'referral', 'recruiter', 'other') OR source IS NULL),
    posted_date DATE,
    closing_date DATE,

    -- ── prioritization signals (see semantic/metrics/priority_score.yaml) ──
    -- compute_priority() force-ranks postings from these. location / remote_policy
    -- / salary_* above are scored deterministically; the three below are the
    -- subjective reads the agent supplies at intake (or via set_priority_signals).
    experience_alignment NUMERIC(3,2)             -- 0..1 fit vs my resume
        CHECK ((experience_alignment BETWEEN 0 AND 1) OR experience_alignment IS NULL),
    career_trajectory TEXT                         -- this role relative to my current level
        CHECK (career_trajectory IN ('step_up', 'lateral', 'step_back') OR career_trajectory IS NULL),
    growth_stage TEXT                              -- the company's stage / upside
        CHECK (growth_stage IN ('seed', 'early', 'growth', 'late', 'public', 'unknown') OR growth_stage IS NULL),

    -- role track judged from the JD by judge-fit (migration 011). A fit/feedback
    -- signal — NOT a compute_priority input. Lets the UI flag a track mismatch
    -- (e.g. an IC resume scored against a manager JD).
    role_type TEXT
        CHECK (role_type IN ('ic', 'manager', 'hybrid', 'unclear') OR role_type IS NULL),

    -- ── lifecycle (migration 012) ──────────────────────────────────────────
    -- A closed posting is one whose role is gone (filled / pulled / no longer
    -- pursued). NULL closed_at = open. A property of the posting, not of any
    -- application — so a role can be closed whether or not I ever applied; the
    -- apply queue filters on closed_at IS NULL. close_role() sets these.
    closed_at TIMESTAMPTZ,
    closed_reason TEXT
        CHECK (closed_reason IN ('filled', 'expired', 'removed', 'no_longer_interested', 'duplicate', 'other')
               OR closed_reason IS NULL),

    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_postings_user ON job_postings(user_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_organization ON job_postings(organization_id);
-- Apply queue + analytics read only open postings; index those.
CREATE INDEX IF NOT EXISTS idx_job_postings_open ON job_postings(user_id) WHERE closed_at IS NULL;

-- ============================================================================
-- applications
-- Fact: one row per submitted application. Status snapshots the current state;
-- the full transition history lives in application_status_history (auto-populated).
-- ============================================================================
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,

    -- Who, if anyone, referred you to this role.
    referral_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

    -- 'closed' (migration 012): the role was filled/pulled while this app was
    -- live — distinct from 'rejected' (they passed) and 'withdrawn' (I pulled out).
    status TEXT NOT NULL DEFAULT 'applied'
        CHECK (status IN ('draft', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'closed')),

    applied_date DATE,
    response_date DATE,

    resume_version TEXT,
    cover_letter_notes TEXT,

    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_user_status ON applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_job_posting ON applications(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_applications_referral ON applications(referral_contact_id) WHERE referral_contact_id IS NOT NULL;

-- ============================================================================
-- application_status_history
-- Auto-populated fact log of every status transition. Lets you compute
-- conversion rates between stages and time-in-stage without relying on the
-- writer to maintain it.
-- ============================================================================
CREATE TABLE IF NOT EXISTS application_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

    from_status TEXT,            -- NULL on the row that records the initial state
    to_status TEXT NOT NULL,

    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_application_status_history_app_time
    ON application_status_history(application_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_application_status_history_user_time
    ON application_status_history(user_id, changed_at);

-- ============================================================================
-- interviews
-- Fact: one row per interview event. Optionally links to events for calendar
-- surfacing, and to contacts for the interviewer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

    interviewer_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

    -- Optional calendar bridge. When populated, the interview appears in
    -- the family-calendar week view via the events table.
    event_id UUID REFERENCES events(id) ON DELETE SET NULL,

    interview_type TEXT
        CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),

    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,

    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),

    notes TEXT,                  -- pre-interview prep
    feedback TEXT,               -- post-interview reflection
    rating INTEGER CHECK ((rating BETWEEN 1 AND 5) OR rating IS NULL),

    -- go/no-go: after this round, do you move forward? Distinct from feedback.
    advance_decision TEXT
        CHECK (advance_decision IN ('advance', 'hold', 'withdraw', 'rejected') OR advance_decision IS NULL),
    decision_notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interviews_application_scheduled
    ON interviews(application_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_interviews_user_scheduled
    ON interviews(user_id, scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interviews_interviewer
    ON interviews(interviewer_contact_id) WHERE interviewer_contact_id IS NOT NULL;

-- job_search_profile (migration 003) was removed by migration 017 — superseded
-- by the `resumes` dim below. get_resume / upsert_resume read & write `resumes`.

-- ============================================================================
-- resumes
-- Dim: one row per resume variant (e.g. a senior-IC resume and a manager
-- resume). Supersedes the single-row job_search_profile; get_resume() reads the
-- default variant for back-compat. The agent scores each against a posting.
-- ============================================================================
CREATE TABLE IF NOT EXISTS resumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    label TEXT NOT NULL,                         -- "Senior IC", "Manager"
    variant TEXT CHECK (variant IN ('ic', 'manager', 'other') OR variant IS NULL),
    resume_text TEXT,
    resume_filename TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_resumes_one_default
    ON resumes(user_id) WHERE is_default;

-- ============================================================================
-- role_fit
-- Fact: one row per (posting × resume) AI-judge read. Holds the fit score the
-- priority framework consumes (lifted into job_postings.experience_alignment by
-- save_role_fit) plus the human-facing summary / spikes / gaps / tweaks.
-- ============================================================================
CREATE TABLE IF NOT EXISTS role_fit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    resume_id UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,

    alignment NUMERIC(3,2)
        CHECK ((alignment BETWEEN 0 AND 1) OR alignment IS NULL),
    summary TEXT,
    spikes JSONB,
    gaps JSONB,
    tweaks JSONB,
    model TEXT,
    judged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (job_posting_id, resume_id)
);

CREATE INDEX IF NOT EXISTS idx_role_fit_user ON role_fit(user_id);
CREATE INDEX IF NOT EXISTS idx_role_fit_posting ON role_fit(job_posting_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- updated_at maintenance (uses the function created by family-calendar)
DROP TRIGGER IF EXISTS update_job_postings_updated_at ON job_postings;
CREATE TRIGGER update_job_postings_updated_at
    BEFORE UPDATE ON job_postings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_applications_updated_at ON applications;
CREATE TRIGGER update_applications_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_interviews_updated_at ON interviews;
CREATE TRIGGER update_interviews_updated_at
    BEFORE UPDATE ON interviews
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_resumes_updated_at ON resumes;
CREATE TRIGGER update_resumes_updated_at
    BEFORE UPDATE ON resumes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_role_fit_updated_at ON role_fit;
CREATE TRIGGER update_role_fit_updated_at
    BEFORE UPDATE ON role_fit
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-log status transitions
CREATE OR REPLACE FUNCTION log_application_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO application_status_history (user_id, application_id, from_status, to_status)
        VALUES (NEW.user_id, NEW.id, NULL, NEW.status);
    ELSIF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO application_status_history (user_id, application_id, from_status, to_status)
        VALUES (NEW.user_id, NEW.id, OLD.status, NEW.status);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS log_application_status_change_trigger ON applications;
CREATE TRIGGER log_application_status_change_trigger
    AFTER INSERT OR UPDATE OF status ON applications
    FOR EACH ROW
    EXECUTE FUNCTION log_application_status_change();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_fit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_postings_user_policy ON job_postings;
CREATE POLICY job_postings_user_policy ON job_postings
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS applications_user_policy ON applications;
CREATE POLICY applications_user_policy ON applications
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS application_status_history_user_policy ON application_status_history;
CREATE POLICY application_status_history_user_policy ON application_status_history
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS interviews_user_policy ON interviews;
CREATE POLICY interviews_user_policy ON interviews
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS resumes_user_policy ON resumes;
CREATE POLICY resumes_user_policy ON resumes
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS role_fit_user_policy ON role_fit;
CREATE POLICY role_fit_user_policy ON role_fit
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- career_profile / career_judgment  (the career_trajectory judge — migration 006)
-- One row per user holds the baseline + ambition the judge needs; career_judgment
-- holds its per-posting reasoning. The trajectory enum still lives on
-- job_postings.career_trajectory (written by save_career_judgment), so
-- compute_priority is unchanged. See supabase/functions/JUDGE_SIGNALS_SPEC.md.
-- ============================================================================
CREATE TABLE IF NOT EXISTS career_profile (
    user_id UUID PRIMARY KEY,
    current_title     TEXT,
    current_level     TEXT,
    current_track     TEXT CHECK (current_track IN ('ic', 'manager') OR current_track IS NULL),
    current_span      INTEGER,
    years_experience  NUMERIC(4,1),
    current_comp      INTEGER,
    primary_domain    TEXT,
    target_track      TEXT CHECK (target_track IN ('ic', 'manager', 'either') OR target_track IS NULL),
    target_level      TEXT,
    target_comp_floor INTEGER,
    forward_means     TEXT[],
    lateral_domains   TEXT[],
    notes             TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS career_judgment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    trajectory  TEXT CHECK (trajectory IN ('step_up', 'lateral', 'step_back') OR trajectory IS NULL),
    confidence  NUMERIC(3,2) CHECK ((confidence BETWEEN 0 AND 1) OR confidence IS NULL),
    deltas      JSONB,
    rationale   TEXT,
    model       TEXT,
    judged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_posting_id)
);

CREATE INDEX IF NOT EXISTS idx_career_judgment_user ON career_judgment(user_id);
CREATE INDEX IF NOT EXISTS idx_career_judgment_posting ON career_judgment(job_posting_id);

DROP TRIGGER IF EXISTS update_career_profile_updated_at ON career_profile;
CREATE TRIGGER update_career_profile_updated_at
    BEFORE UPDATE ON career_profile
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_career_judgment_updated_at ON career_judgment;
CREATE TRIGGER update_career_judgment_updated_at
    BEFORE UPDATE ON career_judgment
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE career_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_judgment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS career_profile_user_policy ON career_profile;
CREATE POLICY career_profile_user_policy ON career_profile
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS career_judgment_user_policy ON career_judgment;
CREATE POLICY career_judgment_user_policy ON career_judgment
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ============================================================================
-- resume_feedback_synthesis  (the cross-role feedback digest — migration 007)
-- One row per resume caches the synthesize-feedback judge's roll-up of every
-- role_fit tweak for that resume into ranked, bucketed themes. Derived data —
-- safe to delete and re-synthesize. source_count records how many judge reads
-- fed the synthesis so the UI can flag it as stale when new judgements land.
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

-- ============================================================================
-- priority_weights  (user-adjustable priority levers — migration 009)
-- One row per user holding the five compute_priority component weights, edited
-- by the Pipeline sliders. No row → the neutral spec default (see
-- semantic/metrics/priority_score.yaml). resolve_priority_weights() reads this;
-- get_action_queue / get_prioritized_roles feed it to compute_priority so the
-- force-ranking the UI and the MCP/agent see stays in sync.
-- ============================================================================
CREATE TABLE IF NOT EXISTS priority_weights (
    user_id     UUID PRIMARY KEY,
    experience  NUMERIC(4,3) NOT NULL DEFAULT 0.350,
    location    NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    comp        NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    career      NUMERIC(4,3) NOT NULL DEFAULT 0.200,
    growth      NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT priority_weights_range CHECK (
        experience BETWEEN 0 AND 1 AND location BETWEEN 0 AND 1
        AND comp BETWEEN 0 AND 1 AND career BETWEEN 0 AND 1 AND growth BETWEEN 0 AND 1
    )
);

DROP TRIGGER IF EXISTS update_priority_weights_updated_at ON priority_weights;
CREATE TRIGGER update_priority_weights_updated_at
    BEFORE UPDATE ON priority_weights
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE priority_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS priority_weights_user_policy ON priority_weights;
CREATE POLICY priority_weights_user_policy ON priority_weights
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- resume_bullets / assembled_resumes  (buildable resume — migration 010)
-- resume_bullets is a library of reusable, tagged, orderable bullets; the
-- assemble-resume edge function scores them against a JD and writes a one-page
-- draft into assembled_resumes (one per posting). resume_feedback_synthesis
-- gains manual_order so its themes can be hand-ranked.
-- ============================================================================
CREATE TABLE IF NOT EXISTS resume_bullets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    section     TEXT NOT NULL,                       -- 'Summary' | 'Experience' | 'Skills' | 'Education' | 'Other'
    org_label   TEXT,                                -- e.g. "Acme — Staff Engineer"
    text        TEXT NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    sort_order  NUMERIC NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    source      TEXT NOT NULL DEFAULT 'manual'
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

CREATE TABLE IF NOT EXISTS assembled_resumes (
    job_posting_id UUID PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL,
    base_resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL,
    body_md        TEXT,
    selected_bullet_ids JSONB,
    rationale      TEXT,
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

ALTER TABLE resume_feedback_synthesis
    ADD COLUMN IF NOT EXISTS manual_order BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- interview_prep_sessions (migration 018)
-- One row per interview: intake notes -> AI research on the people/role -> a
-- live mock-interview chat transcript (incl. out-of-character coach feedback)
-- -> a synthesized bulleted summary. Derived/session data — safe to delete
-- and regenerate. See docs/checklist-feature-discovery.md Feature 3.
-- ============================================================================
CREATE TABLE IF NOT EXISTS interview_prep_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,

    intake_notes TEXT,              -- what the interview covers (user text or an OB thought)
    source_thought_id TEXT,         -- soft ref to Open Brain, mirrors tasks.thought_id

    research JSONB,                 -- { role_summary, role_functions[], people[], prep_focus[] }
    research_model TEXT,
    research_generated_at TIMESTAMPTZ,

    transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{ id, kind: 'interviewer'|'user'|'coach_feedback', content, in_reply_to, created_at }]

    synthesis JSONB,                -- { stories[], competencies[], questions_to_ask[] }
    synthesis_model TEXT,
    synthesized_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (interview_id)
);

CREATE INDEX IF NOT EXISTS idx_interview_prep_sessions_user ON interview_prep_sessions(user_id);

DROP TRIGGER IF EXISTS update_interview_prep_sessions_updated_at ON interview_prep_sessions;
CREATE TRIGGER update_interview_prep_sessions_updated_at
    BEFORE UPDATE ON interview_prep_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE interview_prep_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interview_prep_sessions_user_policy ON interview_prep_sessions;
CREATE POLICY interview_prep_sessions_user_policy ON interview_prep_sessions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
