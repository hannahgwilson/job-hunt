-- Migration 011 — posting role type (IC vs manager), judged from the JD
-- ============================================================================
-- judge-fit now reads the JD and classifies the role as individual-contributor,
-- people-manager, hybrid (player-coach / lead), or unclear — BEFORE scoring the
-- resume, so it assesses against the skills THAT role type demands. The verdict
-- is a property of the posting (same for every resume), so it's cached here
-- rather than per (posting × resume) in role_fit.
--
-- The point: an IC resume scored against a manager JD (or vice versa) is a track
-- mismatch the UI can flag — submitting the wrong track is search misalignment.
-- It does NOT feed compute_priority; it's a fit/feedback signal only.
--
-- get_role_fit (functions.sql) is extended to return role_type — re-run it after
-- this. Additive + idempotent.
-- ============================================================================

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS role_type TEXT
        CHECK (role_type IN ('ic', 'manager', 'hybrid', 'unclear') OR role_type IS NULL);
