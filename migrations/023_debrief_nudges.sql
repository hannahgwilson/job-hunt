-- 023 — Debrief nudges in the action queue (T3.1)
--
-- Overdue un-debriefed rounds used to surface in exactly one place: the
-- Interviews tab's "Needs debrief" section. That's the one screen you're least
-- likely to be on when you're triaging, and until a round is closed out it
-- keeps counting as `interviews_pending` in get_stage_roles and keeps its
-- application looking live in the funnel — so a backlog quietly distorts the
-- metrics rather than just being untidy.
--
-- This adds the same set as a `debrief_overdue` bucket on get_action_queue, so
-- Play 3's weekly review (and the MCP) see it too. The tracking hub computes
-- the same predicate client-side from rows it already has, so the Dashboard
-- tile and the Action Queue card work whether or not this migration has been
-- applied — nothing in the UI depends on this key existing.
--
-- Additive only: every existing key on the returned object is unchanged.
--
-- Apply in the Supabase SQL editor, then re-apply functions.sql (which carries
-- the canonical copy of this definition).

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
        -- Rounds that happened and were never closed out — still 'scheduled'
        -- with the date behind us, or never dated at all (an open undated round
        -- is exactly as much of a loose end as an overdue one). Networking calls
        -- are included deliberately: unlike the analytics buckets, this is a
        -- housekeeping list, and an un-logged coffee chat is still a loose end.
        -- Closing one out (complete_interview) is what clears it (T3.1).
        'debrief_overdue', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_object(
                    'interview_id', i.id,
                    'interview_type', i.interview_type,
                    'category', i.category,
                    'scheduled_at', i.scheduled_at,
                    'application_id', i.application_id,
                    'title', jp.title,
                    'organization_name', coalesce(o.name, io.name)
                ) ORDER BY i.scheduled_at DESC NULLS FIRST
            ), '[]'::jsonb)
            FROM interviews i
            -- LEFT: a networking call has no application; it carries its own org.
            LEFT JOIN applications a   ON a.id = i.application_id
            LEFT JOIN job_postings jp  ON jp.id = a.job_posting_id
            LEFT JOIN organizations o  ON o.id = jp.organization_id
            LEFT JOIN organizations io ON io.id = i.organization_id
            WHERE i.user_id = p_user_id
              AND i.status = 'scheduled'
              AND (i.scheduled_at IS NULL OR i.scheduled_at < now())
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
