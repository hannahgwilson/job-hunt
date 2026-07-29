-- 022_interviews_v2.sql
-- ============================================================================
-- Interviews v2 — the Tier 1/2 backlog (docs/interviews-backlog.md).
--
-- One migration on purpose: several items below rewrite the same functions
-- (get_action_queue is touched by both the category filter and the new
-- decisions bucket), and the two-020s incident showed what happens when
-- parallel migrations fight over one CREATE OR REPLACE. Everything here is
-- re-runnable; functions.sql carries the canonical copies — (re)apply it after
-- this migration.
--
--   T1.5  get_stage_roles gains the application's CURRENT status per row.
--   T2.1  category='interview' filters in get_stage_roles / get_action_queue /
--         get_story_cheat_sheet (D2/D3: networking calls no longer pollute
--         interview analytics).
--   T1.2  advance_decision is wired (D1): a 'rejected'/'withdraw' debrief on a
--         formal round cascades to the application's status; 'hold' rounds
--         surface in get_action_queue.interview_decisions as a decision owed.
--   D5    start_interview_prep seeds intake_notes from interviews.notes, and
--         both prep reads return the scheduling notes, so the context captured
--         at scheduling reaches the AI on the FIRST run.
--   T1.1  find_duplicate_interviews / merge_interviews + (once clean) the
--         partial UNIQUE index schedule_interview's dedup predicate assumes.
--   —     submit_application auto-completes the posting's open 'apply' task
--         (recovered orphan commit 94bc031, guard widened per the backlog).
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- get_stage_roles — + current application status (T1.5), networking calls
-- out of the interview rollup (T2.1/D2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_stage_roles(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH reached AS (
        -- every (application, stage) pair the app EVER reached — mirrors
        -- get_funnel_metrics' hist/stage_counts population.
        SELECT application_id, to_status AS stage, MIN(changed_at) AS reached_at
        FROM application_status_history
        WHERE user_id = p_user_id
          AND to_status IN ('applied', 'screening', 'interviewing', 'offer')
        GROUP BY application_id, to_status
    ),
    applied_at AS (
        SELECT application_id, reached_at AS applied_at FROM reached WHERE stage = 'applied'
    ),
    screen_at AS (
        SELECT application_id, reached_at AS screen_at FROM reached WHERE stage = 'screening'
    ),
    -- per-application interview rollup: completed / still-scheduled counts, plus
    -- the furthest round reached (the type of the chronologically-last interview
    -- that happened or is on the books; cancelled/no_show don't count as "reached").
    -- Formal rounds only — a networking call attached to an application is not
    -- an interview and must not inflate these or win furthest_round (D2).
    iv AS (
        SELECT
            application_id,
            count(*) FILTER (WHERE status = 'completed') AS completed,
            count(*) FILTER (WHERE status = 'scheduled')  AS pending,
            (array_agg(interview_type ORDER BY scheduled_at DESC NULLS LAST)
                FILTER (WHERE status IN ('completed', 'scheduled')))[1] AS furthest_round
        FROM interviews
        WHERE user_id = p_user_id
          AND category = 'interview'
        GROUP BY application_id
    ),
    rows AS (
        SELECT
            r.stage,
            a.id AS application_id,
            -- where the app IS today, vs. the reached-based stage it's listed
            -- under — without this the drill-down can't tell "still here" from
            -- "moved on months ago" (T1.5).
            a.status,
            jp.id AS job_posting_id,
            jp.title,
            o.name AS organization_name,
            COALESCE(iv.completed, 0) AS interviews_completed,
            COALESCE(iv.pending, 0)   AS interviews_pending,
            iv.furthest_round,
            floor(EXTRACT(EPOCH FROM (now() - aa.applied_at)) / 86400.0)::int AS days_since_applied,
            CASE WHEN sa.screen_at IS NOT NULL
                 THEN floor(EXTRACT(EPOCH FROM (now() - sa.screen_at)) / 86400.0)::int
                 ELSE NULL END AS days_since_screen
        FROM reached r
        JOIN applications a  ON a.id = r.application_id
        JOIN job_postings jp ON jp.id = a.job_posting_id
        JOIN organizations o ON o.id = jp.organization_id
        LEFT JOIN iv         ON iv.application_id = a.id
        LEFT JOIN applied_at aa ON aa.application_id = a.id
        LEFT JOIN screen_at  sa ON sa.application_id = a.id
        WHERE a.user_id = p_user_id
    )
    SELECT jsonb_build_object(
        'success', true,
        -- { <stage>: [ {application_id, status, job_posting_id, title,
        --               organization_name, interviews_completed,
        --               interviews_pending, furthest_round,
        --               days_since_applied, days_since_screen}, ... ] }
        'roles', COALESCE((
            SELECT jsonb_object_agg(stage, roles)
            FROM (
                SELECT stage, jsonb_agg(jsonb_build_object(
                    'application_id', application_id,
                    'status', status,
                    'job_posting_id', job_posting_id,
                    'title', title,
                    'organization_name', organization_name,
                    'interviews_completed', interviews_completed,
                    'interviews_pending', interviews_pending,
                    'furthest_round', furthest_round,
                    'days_since_applied', days_since_applied,
                    'days_since_screen', days_since_screen
                ) ORDER BY days_since_applied DESC NULLS LAST) AS roles
                FROM rows
                GROUP BY stage
            ) g
        ), '{}'::jsonb)
    ) INTO result;

    RETURN result;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- get_action_queue — formal rounds only in upcoming_interviews (T2.1/D2), and
-- a new bucket: completed rounds parked on 'hold' whose application is still
-- live — a go/no-go you owe yourself (T1.2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_action_queue(
    p_user_id uuid DEFAULT auth.uid(),
    p_followup_days int DEFAULT 7,
    p_closing_days int DEFAULT 7,
    p_interview_days int DEFAULT 14,
    p_stale_days int DEFAULT 14
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        -- Force-ranked by priority_score (see semantic/metrics/priority_score.yaml).
        -- This bucket is the answer to "what do I apply to next" — top card first.
        -- Delegates to get_prioritized_roles so the apply queue and the Pipeline
        -- ranking share ONE scoring path and can't silently drift (the inline copy
        -- used to omit compute_priority's comp-band args).
        'roles_to_apply', coalesce(
            get_prioritized_roles(p_user_id, p_closing_days) -> 'roles', '[]'::jsonb),
        'role_followups', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'application_id', a.id,
                    'status', a.status,
                    'applied_date', a.applied_date,
                    'days_waiting', (current_date - a.applied_date),
                    'title', jp.title,
                    'organization_name', o.name,
                    'url', jp.url
                ) ORDER BY a.applied_date ASC
            ), '[]'::jsonb)
            FROM applications a
            JOIN job_postings jp ON jp.id = a.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE a.user_id = p_user_id
              AND a.response_date IS NULL
              AND a.status IN ('applied', 'screening', 'interviewing')
              AND a.applied_date IS NOT NULL
              AND a.applied_date <= current_date - p_followup_days
        ),
        'upcoming_interviews', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'interview_id', i.id,
                    'interview_type', i.interview_type,
                    'scheduled_at', i.scheduled_at,
                    'title', jp.title,
                    'organization_name', o.name
                ) ORDER BY i.scheduled_at ASC
            ), '[]'::jsonb)
            FROM interviews i
            JOIN applications a ON a.id = i.application_id
            JOIN job_postings jp ON jp.id = a.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE i.user_id = p_user_id
              AND i.category = 'interview'   -- networking calls are not rounds (D2)
              AND i.status = 'scheduled'
              AND i.scheduled_at >= now()
              AND i.scheduled_at <= now() + make_interval(days => p_interview_days)
        ),
        -- Debriefed 'hold' rounds on live applications: the explicit "do I move
        -- forward?" you deferred. Advancing/withdrawing the application (or
        -- re-debriefing the round) clears the row (T1.2).
        'interview_decisions', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'interview_id', i.id,
                    'interview_type', i.interview_type,
                    'scheduled_at', i.scheduled_at,
                    'application_id', a.id,
                    'application_status', a.status,
                    'decision_notes', i.decision_notes,
                    'title', jp.title,
                    'organization_name', o.name
                ) ORDER BY i.scheduled_at DESC NULLS LAST
            ), '[]'::jsonb)
            FROM interviews i
            JOIN applications a ON a.id = i.application_id
            JOIN job_postings jp ON jp.id = a.job_posting_id
            JOIN organizations o ON o.id = jp.organization_id
            WHERE i.user_id = p_user_id
              AND i.category = 'interview'
              AND i.status = 'completed'
              AND i.advance_decision = 'hold'
              AND a.status IN ('applied', 'screening', 'interviewing', 'offer')
        ),
        'networking', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'contact_id', c.id,
                    'name', c.name,
                    'title', c.title,
                    'last_contacted', c.last_contacted,
                    'organization_name', o.name
                ) ORDER BY c.last_contacted ASC NULLS FIRST
            ), '[]'::jsonb)
            FROM contacts c
            LEFT JOIN organizations o ON o.id = c.organization_id
            WHERE c.user_id = p_user_id
              AND c.tags && ARRAY['job-hunt']
              AND (c.last_contacted IS NULL
                   OR c.last_contacted <= current_date - p_stale_days)
        )
    );
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- get_story_cheat_sheet — scope to formal rounds, enforcing the invariant
-- migration 020's header claims (D3). Works today only by accident (networking
-- calls rarely have a synthesized prep session).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_story_cheat_sheet(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'sessions', COALESCE(jsonb_agg(
            jsonb_build_object(
                'interview_id', i.id,
                'interview_type', i.interview_type,
                'scheduled_at', i.scheduled_at,
                'application_id', a.id,
                'job_posting_id', a.job_posting_id,
                'role_title', jp.title,
                'organization_id', jp.organization_id,
                'organization_name', o.name,
                'synthesized_at', s.synthesized_at,
                'stories', COALESCE(s.synthesis->'stories', '[]'::jsonb),
                'competencies', COALESCE(s.synthesis->'competencies', '[]'::jsonb),
                'questions_to_ask', COALESCE(s.synthesis->'questions_to_ask', '[]'::jsonb)
            )
            ORDER BY o.name, COALESCE(i.scheduled_at, s.synthesized_at) DESC
        ), '[]'::jsonb)
    )
    FROM interview_prep_sessions s
    JOIN interviews i     ON i.id = s.interview_id
    JOIN applications a   ON a.id = i.application_id
    JOIN job_postings jp  ON jp.id = a.job_posting_id
    JOIN organizations o  ON o.id = jp.organization_id
    WHERE s.user_id = p_user_id
      AND i.category = 'interview'
      AND s.synthesis IS NOT NULL;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- complete_interview — wire the go/no-go (T1.2, fixes D1). A debrief that
-- lands 'rejected' or 'withdraw' on a formal round now cascades to the
-- application's own status (through the same UPDATE path the history trigger
-- watches), so the app no longer sits at 'interviewing' forever after a no.
--
-- Deliberate choices, per the backlog:
--   * Only the two terminal decisions cascade. 'advance' doesn't auto-bump the
--     application forward (which stage it lands in is a judgment call), and
--     'hold' surfaces in get_action_queue.interview_decisions instead.
--   * A 'rejected' debrief on ANY round terminates the application — "they
--     passed" is a verdict on the application, not on the round. If a round's
--     no wasn't final after all, Reopen the round and move the application
--     back by hand; the cascade never fires on an app already terminal.
--   * The application's own notes are left alone — the rationale lives on the
--     interview row (feedback / decision_notes), and the history trigger logs
--     the transition itself.
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
    v_app_status text;
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

    -- The cascade fires only on an EXPLICIT terminal decision in this call
    -- (p_advance_decision, not the COALESCEd stored value) so re-saving an old
    -- debrief or a bare "mark it done" can never move the application.
    IF p_advance_decision IN ('rejected', 'withdraw')
       AND p_status = 'completed'
       AND v_interview.category = 'interview'
       AND v_interview.application_id IS NOT NULL THEN
        SELECT status INTO v_app_status
        FROM applications
        WHERE id = v_interview.application_id AND user_id = p_user_id;

        IF v_app_status IN ('applied', 'screening', 'interviewing', 'offer') THEN
            UPDATE applications
            SET status = CASE p_advance_decision WHEN 'rejected' THEN 'rejected' ELSE 'withdrawn' END,
                response_date = COALESCE(response_date, current_date)
            WHERE id = v_interview.application_id AND user_id = p_user_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'interview', to_jsonb(v_interview));
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- start_interview_prep — seed the intake from the round's scheduling notes
-- (D5). interviews.notes is where "Competencies: …, Interviewer: …" actually
-- lands at scheduling time; a fresh session now starts grounded in it instead
-- of making you retype it into the intake box.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION start_interview_prep(
    p_interview_id uuid,
    p_intake_notes text DEFAULT NULL,
    p_source_thought_id text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'start_interview_prep: no user_id';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM interviews WHERE id = p_interview_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'start_interview_prep: interview % not found', p_interview_id;
    END IF;

    INSERT INTO interview_prep_sessions (user_id, interview_id, intake_notes, source_thought_id)
    VALUES (
        p_user_id,
        p_interview_id,
        COALESCE(
            p_intake_notes,
            (SELECT notes FROM interviews WHERE id = p_interview_id AND user_id = p_user_id)
        ),
        p_source_thought_id
    )
    ON CONFLICT (interview_id) DO UPDATE SET
        intake_notes = COALESCE(EXCLUDED.intake_notes, interview_prep_sessions.intake_notes),
        source_thought_id = COALESCE(EXCLUDED.source_thought_id, interview_prep_sessions.source_thought_id);

    RETURN get_interview_prep_session(p_interview_id, p_user_id);
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- get_interview_prep_session — carry the scheduling notes on the interview
-- object (D5): the page pre-fills a fresh intake box from them, and the
-- interview-prep edge function folds them into the model context.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_interview_prep_session(
    p_interview_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH iv AS (
        SELECT i.id, i.interview_type, i.scheduled_at, i.status, i.notes,
               i.interviewer_contact_id,
               a.id AS application_id, a.job_posting_id, jp.title AS role_title,
               jp.organization_id, jp.growth_stage, o.name AS organization_name,
               o.growth_signals, o.growth_rationale
        FROM interviews i
        JOIN applications a  ON a.id = i.application_id
        JOIN job_postings jp ON jp.id = a.job_posting_id
        JOIN organizations o ON o.id = jp.organization_id
        WHERE i.id = p_interview_id AND i.user_id = p_user_id
    )
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM iv)
        THEN jsonb_build_object('success', false, 'error', 'interview not found')
        ELSE (
            SELECT jsonb_build_object(
                'success', true,
                'interview', jsonb_build_object(
                    'id', iv.id, 'interview_type', iv.interview_type,
                    'scheduled_at', iv.scheduled_at, 'status', iv.status,
                    'notes', iv.notes),
                'role', jsonb_build_object(
                    'application_id', iv.application_id,
                    'job_posting_id', iv.job_posting_id, 'title', iv.role_title,
                    'organization_id', iv.organization_id,
                    'organization_name', iv.organization_name),
                'company_intel', jsonb_build_object(
                    'growth_stage', iv.growth_stage,
                    'growth_signals', iv.growth_signals,
                    'growth_rationale', iv.growth_rationale),
                'fit', (
                    SELECT jsonb_build_object(
                        'alignment', rf.alignment, 'summary', rf.summary,
                        'spikes', rf.spikes, 'gaps', rf.gaps, 'resume_label', r.label)
                    FROM role_fit rf
                    JOIN resumes r ON r.id = rf.resume_id
                    WHERE rf.job_posting_id = iv.job_posting_id
                    ORDER BY rf.alignment DESC NULLS LAST
                    LIMIT 1),
                'interviewer', (
                    SELECT jsonb_build_object(
                        'contact_id', c.id, 'name', c.name, 'title', c.title,
                        'last_contacted', c.last_contacted)
                    FROM contacts c WHERE c.id = iv.interviewer_contact_id),
                'ob_suggestions', (
                    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'thought_id', n.id, 'content', n.content, 'created_at', n.created_at)
                        ORDER BY n.created_at DESC), '[]'::jsonb)
                    FROM (
                        SELECT id, content, created_at FROM thoughts
                        WHERE metadata @> jsonb_build_object(
                                'topics', jsonb_build_array(iv.organization_name))
                        ORDER BY created_at DESC LIMIT 8
                    ) n),
                'session', (
                    SELECT to_jsonb(s) FROM interview_prep_sessions s
                    WHERE s.interview_id = p_interview_id AND s.user_id = p_user_id)
            )
            FROM iv)
    END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- T1.1 — duplicate review & merge. Migration 021's find-or-create guards NEW
-- duplicates; these are the tools for the backlog it left in place. A reviewed
-- merge, never a blind DELETE: prep sessions are ON DELETE CASCADE with
-- UNIQUE(interview_id), and a dupe's calendar event would otherwise be
-- orphaned in the week view.
-- ─────────────────────────────────────────────────────────────────────────────

-- find_duplicate_interviews — collision groups on the same natural key
-- schedule_interview dedups on. Within each group the interviews array is
-- ordered best-keeper-first: has a synthesized prep > has any prep > oldest.
CREATE OR REPLACE FUNCTION find_duplicate_interviews(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'groups', COALESCE(jsonb_agg(g.grp ORDER BY g.scheduled_at DESC), '[]'::jsonb)
    )
    FROM (
        SELECT i.scheduled_at, jsonb_build_object(
            'application_id', i.application_id,
            'organization_id', i.organization_id,
            'scheduled_at', i.scheduled_at,
            'interview_type', i.interview_type,
            'title', max(jp.title),
            'organization_name', COALESCE(max(o.name), max(o2.name)),
            'count', count(*),
            'interviews', jsonb_agg(jsonb_build_object(
                'id', i.id,
                'status', i.status,
                'category', i.category,
                'created_at', i.created_at,
                'notes', i.notes,
                'rating', i.rating,
                'feedback', i.feedback,
                'advance_decision', i.advance_decision,
                'has_event', (i.event_id IS NOT NULL),
                'has_prep', (s.interview_id IS NOT NULL),
                'has_synthesis', (s.synthesis IS NOT NULL)
            ) ORDER BY (s.synthesis IS NOT NULL) DESC,
                       (s.interview_id IS NOT NULL) DESC,
                       i.created_at ASC)
        ) AS grp
        FROM interviews i
        LEFT JOIN interview_prep_sessions s ON s.interview_id = i.id
        LEFT JOIN applications a  ON a.id = i.application_id
        LEFT JOIN job_postings jp ON jp.id = a.job_posting_id
        LEFT JOIN organizations o ON o.id = jp.organization_id
        LEFT JOIN organizations o2 ON o2.id = i.organization_id
        WHERE i.user_id = p_user_id
          AND i.scheduled_at IS NOT NULL
          AND i.status <> 'cancelled'
        GROUP BY i.application_id, i.organization_id, i.scheduled_at, i.interview_type
        HAVING count(*) > 1
    ) g;
$$;

-- merge_interviews — collapse duplicates into one reviewed keeper. Blank
-- fields on the keeper are filled from each dupe (never clobbered); prep
-- sessions and checklist tasks are re-pointed; a dupe's now-redundant calendar
-- event is removed (it was the duplicate the import minted); then the dupe row
-- is deleted. Refuses to merge when both rounds carry a prep session — that
-- needs a human pick, not a silent overwrite.
CREATE OR REPLACE FUNCTION merge_interviews(
    p_keep_id uuid,
    p_merge_ids uuid[],
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_keep interviews;
    v_dupe interviews;
    v_dupe_id uuid;
    v_keep_event uuid;
    v_merged int := 0;
    v_events_removed int := 0;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'merge_interviews: no user_id';
    END IF;

    SELECT * INTO v_keep FROM interviews WHERE id = p_keep_id AND user_id = p_user_id;
    IF v_keep.id IS NULL THEN
        RAISE EXCEPTION 'merge_interviews: keeper % not found or not owned', p_keep_id;
    END IF;

    FOREACH v_dupe_id IN ARRAY p_merge_ids LOOP
        CONTINUE WHEN v_dupe_id = p_keep_id;

        SELECT * INTO v_dupe FROM interviews WHERE id = v_dupe_id AND user_id = p_user_id;
        IF v_dupe.id IS NULL THEN
            RAISE EXCEPTION 'merge_interviews: interview % not found or not owned', v_dupe_id;
        END IF;

        IF EXISTS (SELECT 1 FROM interview_prep_sessions WHERE interview_id = v_dupe_id) THEN
            IF EXISTS (SELECT 1 FROM interview_prep_sessions WHERE interview_id = p_keep_id) THEN
                RAISE EXCEPTION 'merge_interviews: both % and % carry a prep session — keep the round whose prep you want and merge the other way, or resolve by hand', p_keep_id, v_dupe_id;
            END IF;
            UPDATE interview_prep_sessions SET interview_id = p_keep_id
            WHERE interview_id = v_dupe_id AND user_id = p_user_id;
        END IF;

        UPDATE tasks SET interview_id = p_keep_id
        WHERE interview_id = v_dupe_id AND user_id = p_user_id;

        UPDATE interviews SET
            interview_type         = COALESCE(interview_type, v_dupe.interview_type),
            duration_minutes       = COALESCE(duration_minutes, v_dupe.duration_minutes),
            interviewer_contact_id = COALESCE(interviewer_contact_id, v_dupe.interviewer_contact_id),
            event_id               = COALESCE(event_id, v_dupe.event_id),
            rating                 = COALESCE(rating, v_dupe.rating),
            feedback               = COALESCE(feedback, v_dupe.feedback),
            advance_decision       = COALESCE(advance_decision, v_dupe.advance_decision),
            decision_notes         = COALESCE(decision_notes, v_dupe.decision_notes),
            notes = CASE
                WHEN notes IS NULL THEN v_dupe.notes
                WHEN v_dupe.notes IS NULL OR v_dupe.notes = notes THEN notes
                ELSE notes || E'\n\n' || v_dupe.notes
            END
        WHERE id = p_keep_id AND user_id = p_user_id;

        -- The keeper may have just adopted the dupe's event via the COALESCE
        -- above; only an event the keeper did NOT take is the redundant copy.
        SELECT event_id INTO v_keep_event FROM interviews WHERE id = p_keep_id;
        IF v_dupe.event_id IS NOT NULL AND v_dupe.event_id IS DISTINCT FROM v_keep_event THEN
            DELETE FROM events WHERE id = v_dupe.event_id AND user_id = p_user_id;
            v_events_removed := v_events_removed + 1;
        END IF;

        DELETE FROM interviews WHERE id = v_dupe_id AND user_id = p_user_id;
        v_merged := v_merged + 1;
    END LOOP;

    SELECT * INTO v_keep FROM interviews WHERE id = p_keep_id AND user_id = p_user_id;
    RETURN jsonb_build_object(
        'success', true,
        'merged', v_merged,
        'calendar_events_removed', v_events_removed,
        'interview', to_jsonb(v_keep)
    );
END;
$$;

-- The UNIQUE guard schedule_interview's predicate assumes. Creating it against
-- dirty data would fail the whole migration, so it's conditional: while
-- duplicates remain it just NOTICEs — merge them (Interviews → Past →
-- Duplicate rounds, or merge_interviews from chat), then re-run this block.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM interviews
        WHERE scheduled_at IS NOT NULL AND status <> 'cancelled'
        GROUP BY user_id, application_id, organization_id, scheduled_at, interview_type
        HAVING count(*) > 1
    ) THEN
        RAISE NOTICE 'interviews: duplicates remain — unique index NOT created; merge them and re-run this migration.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS uq_interviews_natural_key
            ON interviews (user_id, application_id, organization_id, scheduled_at, interview_type)
            NULLS NOT DISTINCT
            WHERE scheduled_at IS NOT NULL AND status <> 'cancelled';
    END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- submit_application — auto-complete the posting's 'apply' checklist task
-- (recovered orphan commit 94bc031). The original guarded on status='applied';
-- widened to any non-draft status per the backlog appendix — logging a role
-- directly at screening still means you unambiguously applied.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION submit_application(
    p_job_posting_id uuid,
    p_referral_contact_id uuid DEFAULT NULL,
    p_status text DEFAULT 'applied',
    p_applied_date date DEFAULT current_date,
    p_resume_version text DEFAULT NULL,
    p_cover_letter_notes text DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_app applications;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'submit_application: no user_id';
    END IF;

    INSERT INTO applications (
        user_id, job_posting_id, referral_contact_id,
        status, applied_date, resume_version, cover_letter_notes, notes
    )
    VALUES (
        p_user_id, p_job_posting_id, p_referral_contact_id,
        coalesce(p_status, 'applied'), p_applied_date,
        p_resume_version, p_cover_letter_notes, p_notes
    )
    RETURNING * INTO v_app;

    -- Once the application exists, the reminder to apply has done its job.
    IF v_app.status <> 'draft' THEN
        UPDATE tasks
           SET status = 'done', completed_at = now()
         WHERE user_id = p_user_id
           AND domain = 'job-hunt'
           AND kind = 'apply'
           AND job_posting_id = p_job_posting_id
           AND status IN ('open', 'snoozed');
    END IF;

    RETURN jsonb_build_object('success', true, 'application', to_jsonb(v_app));
END;
$$;


GRANT EXECUTE ON FUNCTION find_duplicate_interviews(uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION merge_interviews(uuid, uuid[], uuid) TO authenticated, service_role;
