-- 021_interview_completion.sql
-- ============================================================================
-- Marking an interview done, and not creating duplicates in the first place.
--
-- Two problems this fixes:
--
--   1. `interviews.status` has supported 'completed' | 'cancelled' | 'no_show'
--      since the original schema, but the ONLY writer was the MCP tool
--      `log_interview_notes` — a raw .update() reachable only conversationally.
--      The tracking hub could render status but never change it, so every
--      interview stayed 'scheduled' forever. New `complete_interview` is the
--      SQL home for that transition; the MCP tool now wraps it (logic-in-SQL,
--      same as intake_role / update_application_status).
--
--   2. `schedule_interview` was an unconditional INSERT with no natural key, so
--      re-running an agent-driven calendar import inserted a second copy of
--      every round (and, via the MCP calendar bridge, a second `events` row).
--      It now find-or-creates: same application + same scheduled_at + same
--      interview_type is treated as the same round.
--
-- NOTE: this does NOT add a UNIQUE index — existing duplicates would make the
-- CREATE fail. The constraint lands with the dedupe/merge tool, once the
-- current collisions have been reviewed and merged (deleting the wrong copy of
-- a pair destroys its interview_prep_sessions row, which is why that is a
-- reviewed merge and not a blind DELETE). Until then the guard below stops the
-- population from growing.
--
-- Re-runnable. Mirrored in functions.sql (canonical).
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


-- ─────────────────────────────────────────────────────────────────────────────
-- schedule_interview — now find-or-create, and now carries the columns the MCP
-- tool used to insert directly (duration, interviewer, event bridge) so both
-- callers share one dedup predicate instead of drifting apart.
--
-- The old 5-arg signature is dropped explicitly: adding trailing defaulted
-- params would otherwise leave an overload behind and make calls ambiguous.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS schedule_interview(uuid, timestamptz, text, text, uuid);

CREATE OR REPLACE FUNCTION schedule_interview(
    p_application_id uuid,
    p_scheduled_at timestamptz DEFAULT NULL,
    p_interview_type text DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_duration_minutes integer DEFAULT NULL,
    p_interviewer_contact_id uuid DEFAULT NULL,
    p_event_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_interview interviews;
    v_created boolean := false;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'schedule_interview: no user_id';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM applications WHERE id = p_application_id AND user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'schedule_interview: application % not found or not owned', p_application_id;
    END IF;

    -- Find-or-create. The natural key is (application, scheduled_at,
    -- interview_type):
    --   * only when scheduled_at IS NOT NULL — two undated placeholders on the
    --     same application are two distinct intentions, not a collision;
    --   * IS NOT DISTINCT FROM on interview_type so NULL matches NULL (an
    --     untyped round scheduled twice is still one round);
    --   * cancelled rows are skipped, so re-booking a round you cancelled
    --     creates a fresh one instead of resurrecting the dead row.
    IF p_scheduled_at IS NOT NULL THEN
        SELECT * INTO v_interview
        FROM interviews
        WHERE user_id = p_user_id
          AND application_id = p_application_id
          AND scheduled_at = p_scheduled_at
          AND interview_type IS NOT DISTINCT FROM p_interview_type
          AND status <> 'cancelled'
        ORDER BY created_at ASC   -- if dupes already exist, settle on the first
        LIMIT 1;
    END IF;

    IF v_interview.id IS NULL THEN
        INSERT INTO interviews (
            user_id, application_id, interview_type, scheduled_at,
            notes, duration_minutes, interviewer_contact_id, event_id
        )
        VALUES (
            p_user_id, p_application_id, p_interview_type, p_scheduled_at,
            p_notes, p_duration_minutes, p_interviewer_contact_id, p_event_id
        )
        RETURNING * INTO v_interview;
        v_created := true;
    ELSE
        -- Re-scheduling an existing round fills in blanks but never clobbers
        -- what's already recorded — a re-import must not wipe hand-written
        -- notes or unlink a calendar event.
        UPDATE interviews
        SET notes                 = COALESCE(notes, p_notes),
            duration_minutes      = COALESCE(duration_minutes, p_duration_minutes),
            interviewer_contact_id = COALESCE(interviewer_contact_id, p_interviewer_contact_id),
            event_id              = COALESCE(event_id, p_event_id)
        WHERE id = v_interview.id
        RETURNING * INTO v_interview;
    END IF;

    -- `created` lets the caller tell "booked" from "already on the books" —
    -- the MCP handler uses it to skip minting a second calendar event.
    RETURN jsonb_build_object(
        'success', true,
        'created', v_created,
        'interview', to_jsonb(v_interview)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION schedule_interview(uuid, timestamptz, text, text, integer, uuid, uuid, uuid)
    TO authenticated, service_role;
