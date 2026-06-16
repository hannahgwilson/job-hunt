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

    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_postings_user ON job_postings(user_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_organization ON job_postings(organization_id);

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

    status TEXT NOT NULL DEFAULT 'applied'
        CHECK (status IN ('draft', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn')),

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

-- ============================================================================
-- job_search_profile
-- One row per user: the long-form resume the prioritization framework scores
-- `experience_alignment` against (see semantic/metrics/priority_score.yaml).
-- Stored as text so the agent can read it directly; never committed to the repo.
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_search_profile (
    user_id UUID PRIMARY KEY,
    resume_text TEXT,
    resume_filename TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

DROP TRIGGER IF EXISTS update_job_search_profile_updated_at ON job_search_profile;
CREATE TRIGGER update_job_search_profile_updated_at
    BEFORE UPDATE ON job_search_profile
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
ALTER TABLE job_search_profile ENABLE ROW LEVEL SECURITY;
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

DROP POLICY IF EXISTS job_search_profile_user_policy ON job_search_profile;
CREATE POLICY job_search_profile_user_policy ON job_search_profile
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS resumes_user_policy ON resumes;
CREATE POLICY resumes_user_policy ON resumes
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS role_fit_user_policy ON role_fit;
CREATE POLICY role_fit_user_policy ON role_fit
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
