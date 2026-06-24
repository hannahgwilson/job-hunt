-- Migration 013 — per-requirement adjacency table on role_fit
-- ============================================================================
-- judge-fit used to emit a single holistic `alignment` number plus prose
-- spikes/gaps. That hid HOW the score was reached and let literal keyword
-- matching creep in (a Looker resume scored as a Gap against a Tableau JD).
--
-- The judge now classifies each JD requirement into a four-tier adjacency
-- framework (identical / adjacent / aware / gap) and derives `alignment` as the
-- importance-weighted average of those tiers — chain-of-thought that keeps the
-- score honest and, crucially, *defensible in an interview*. We persist that
-- table so the role page can show the reasoning, not just the number.
--
--   role_fit.requirement_scores  — jsonb array, one object per requirement:
--     { requirement, importance: 'required'|'nice_to_have',
--       tier: 'identical'|'adjacent'|'aware'|'gap', rule, evidence }
--   NULL for rows judged before this migration (re-run the judge to backfill).
--
-- save_role_fit / get_role_fit are updated in functions.sql — re-apply it after
-- this. Additive + idempotent.
-- ============================================================================

ALTER TABLE role_fit
    ADD COLUMN IF NOT EXISTS requirement_scores jsonb;

-- save_role_fit grows a p_requirement_scores arg. Adding a parameter makes a NEW
-- overload rather than replacing in place, so drop the old 9-arg signature first
-- — otherwise both linger and the RPC call becomes ambiguous. (functions.sql then
-- recreates the 10-arg version.)
DROP FUNCTION IF EXISTS save_role_fit(uuid, uuid, numeric, text, jsonb, jsonb, jsonb, text, uuid);

COMMENT ON COLUMN role_fit.requirement_scores IS
    'Per-requirement adjacency table from judge-fit: [{requirement, importance, tier, rule, evidence}]. The alignment score is the importance-weighted average of the tier weights (identical 1.0 / adjacent 0.75 / aware 0.2 / gap 0.0).';
