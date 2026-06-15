-- Migration 001 — interview go/no-go decisions
-- ============================================================================
-- Adds an explicit "do I move forward after this round?" decision to each
-- interview, separate from the post-interview feedback/rating. Lets the funnel
-- distinguish "rejected by them" from "I withdrew" and surfaces a clear next
-- step per round in the action queue / UI.
--
-- Idempotent. Safe to run against an already-deployed job-hunt schema.
-- For fresh installs these columns are already in schema.sql.
-- ============================================================================

ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS advance_decision TEXT
        CHECK (advance_decision IN ('advance', 'hold', 'withdraw', 'rejected')
               OR advance_decision IS NULL);

ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS decision_notes TEXT;
