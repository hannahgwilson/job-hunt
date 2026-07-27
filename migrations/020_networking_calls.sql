-- Migration 020: networking calls on the interviews fact
--
-- The new Interviews tab's "Upcoming" view needs one chronological list of
-- both formal interview rounds (tied to an application) and networking calls
-- (coffee chats, informational interviews, recruiter calls with someone at a
-- target company where there's no live application yet). Rather than fork a
-- second fact table off the CRM's contact-interaction log — a different grain
-- (retrospective log entry / staleness signal, no fixed time) — this widens
-- the existing `interviews` fact, which already has the right grain (a
-- scheduled conversation, with a time, optionally linked to a contact via
-- interviewer_contact_id) and is already conformed to `contacts`.
--
-- `application_id` becomes optional; a direct `organization_id` covers the
-- case where there's no application (yet) to hang the org off of. `category`
-- distinguishes the two so funnel metrics (advance_decision, rating — all
-- interview-loop concepts) don't get pulled toward rows that will naturally
-- leave them null. The synthesis/story-cheat-sheet flow stays scoped to
-- `category = 'interview'` rows — see get_story_cheat_sheet in functions.sql,
-- unchanged in this migration.

ALTER TABLE interviews ALTER COLUMN application_id DROP NOT NULL;

ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'interview'
        CHECK (category IN ('interview', 'networking'));

-- Widen interview_type to cover networking-call shapes. Postgres auto-names
-- an inline CHECK on `interviews.interview_type` as interviews_interview_type_check.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_interview_type_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_interview_type_check
    CHECK (interview_type IN (
        'phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final',
        'recruiter_call', 'networking_call', 'coffee_chat', 'informational'
    ));

ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_application_or_org;
ALTER TABLE interviews ADD CONSTRAINT interviews_application_or_org
    CHECK (application_id IS NOT NULL OR organization_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_interviews_organization
    ON interviews(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interviews_category
    ON interviews(user_id, category, scheduled_at);
