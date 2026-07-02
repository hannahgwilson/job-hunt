-- Migration 016: Action checklist — job-hunt's links into the canonical tasks dim
--
-- The `tasks` fact is a SHARED schema (OB1 schemas/tasks). This migration is the
-- job-hunt EXTENSION of it: nullable FK columns so a task can point at the
-- job-hunt row it's about — exactly how the organizations schema added
-- `contacts.organization_id`. `tasks.domain = 'job-hunt'` says a task is ours;
-- these FKs say which row it concerns.
--
-- Dependency: apply the canonical `tasks` table first
-- (OB1/schemas/tasks/schema.sql). job_postings / applications / interviews /
-- contacts already exist. After this migration, (re)apply functions.sql for the
-- new reads (get_job_checklist, get_suggestions, dismiss_suggestion,
-- promote_suggestion, get_interview_prep) and the get_action_queue de-dup.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS job_posting_id UUID
    REFERENCES job_postings(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS application_id UUID
    REFERENCES applications(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS interview_id UUID
    REFERENCES interviews(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_job_posting
    ON tasks(job_posting_id) WHERE job_posting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_application
    ON tasks(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_interview
    ON tasks(interview_id) WHERE interview_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_contact
    ON tasks(contact_id) WHERE contact_id IS NOT NULL;
