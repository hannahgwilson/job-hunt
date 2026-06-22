-- Migration 012 — close out a role that's been filled (or otherwise gone)
-- ============================================================================
-- "Filled" is a property of the *posting* (the opportunity in the world), not of
-- my application — which is exactly why it can happen BEFORE I apply (the role
-- never enters my pipeline) or AFTER (someone else got it). So the closed state
-- lives on job_postings, independent of any application:
--
--   * closed_at      — NULL = open; set = the role is closed. Source of truth.
--   * closed_reason  — why it closed; 'filled' is the headline case.
--
-- A closed posting drops out of the apply queue (get_action_queue.roles_to_apply
-- and get_prioritized_roles filter closed_at IS NULL) whether or not I'd applied.
--
-- For a role I HAD applied to, close_role() cascades the live application to a
-- new terminal status 'closed' — distinct from 'rejected' (they passed on me)
-- and 'withdrawn' (I pulled out): the role closed, it wasn't a verdict on me.
-- Terminal applications (accepted / rejected / withdrawn) are left untouched.
-- The status-history trigger logs the transition, and role_followups drops it
-- for free (it only chases applied/screening/interviewing).
--
-- close_role / reopen_role live in functions.sql — re-apply it after this.
-- Additive + idempotent.
-- ============================================================================

-- ── posting lifecycle ──────────────────────────────────────────────────────
ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS closed_reason TEXT
        CHECK (closed_reason IN ('filled', 'expired', 'removed', 'no_longer_interested', 'other')
               OR closed_reason IS NULL);

-- Most reads (apply queue, analytics) want only open postings, so index those.
CREATE INDEX IF NOT EXISTS idx_job_postings_open
    ON job_postings(user_id) WHERE closed_at IS NULL;

-- ── application terminal status: 'closed' ──────────────────────────────────
-- Widen the inline status CHECK (auto-named applications_status_check) to admit
-- 'closed'. Guarded so it's safe to re-run.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
    CHECK (status IN ('draft', 'applied', 'screening', 'interviewing',
                      'offer', 'accepted', 'rejected', 'withdrawn', 'closed'));
