-- 021_interview_completion.sql
-- ============================================================================
-- Marking an interview done.
--
-- `interviews.status` has supported 'completed' | 'cancelled' | 'no_show'
-- since the original schema, but the ONLY writer was the MCP tool
-- `log_interview_notes` — a raw .update() reachable only conversationally.
-- The tracking hub could render status but never change it, so every
-- interview stayed 'scheduled' forever. New `complete_interview` is the
-- SQL home for that transition; the MCP tool now wraps it (logic-in-SQL,
-- same as intake_role / update_application_status).
--
-- schedule_interview's find-or-create dedup (so a re-run calendar import is a
-- no-op instead of a second copy) is folded into the SAME function-signature
-- change that added networking-call support — see migration 020's companion
-- update in functions.sql, not here, so the two don't fight over one
-- CREATE OR REPLACE. No table DDL in this migration at all.
--
-- Re-runnable. Mirrored in functions.sql (canonical) — (re)apply functions.sql
-- after this migration for the schedule_interview/complete_interview RPCs.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- complete_interview — the post-round debrief write.
-- Sets the outcome status and, optionally, the reflection fields. NULL args
-- leave the existing value alone, so "just mark it done" and "mark it done AND
-- record the go/no-go" are the same call with different arity.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION complete_interview(
    p_interview_id uuid,
    p_status text DEFAULT 'completed',
    p_rating integer DEFAULT NULL,
    p_feedback text DEFAULT NULL,
    p_advance_decision text DEFAULT NULL,
    p_decision_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_interview interviews;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'complete_interview: no user_id';
    END IF;

    -- Guard the enum here rather than relying on the column CHECK: a bad value
    -- from the UI should name the allowed set, not surface a constraint error.
    IF p_status NOT IN ('scheduled', 'completed', 'cancelled', 'no_show') THEN
        RAISE EXCEPTION 'complete_interview: status must be one of scheduled, completed, cancelled, no_show (got %)', p_status;
    END IF;

    UPDATE interviews
    SET status           = p_status,
        rating           = COALESCE(p_rating, rating),
        feedback         = COALESCE(p_feedback, feedback),
        advance_decision = COALESCE(p_advance_decision, advance_decision),
        decision_notes   = COALESCE(p_decision_notes, decision_notes)
    WHERE id = p_interview_id
      AND user_id = p_user_id
    RETURNING * INTO v_interview;

    IF v_interview.id IS NULL THEN
        RAISE EXCEPTION 'complete_interview: interview % not found or not owned', p_interview_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'interview', to_jsonb(v_interview));
END;
$$;

GRANT EXECUTE ON FUNCTION complete_interview(uuid, text, integer, text, text, text, uuid)
    TO authenticated, service_role;
