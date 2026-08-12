-- 025_rpc_user_scope_guard.sql
-- ============================================================================
-- Pin every SECURITY DEFINER RPC to the calling user (security fix).
--
-- The bug: SECURITY DEFINER bypasses RLS, so on those functions `p_user_id`
-- was the ONLY thing scoping the read — and it is a caller-supplied argument
-- with a *default* of auth.uid(), not a constraint. Any browser holding the
-- public anon key could pass someone else's uuid and read their rows:
--
--     supabase.rpc('get_coaching_profile', { p_user_id: '<another user>' })
--
-- Reproduced locally against dev/local_db.sh as both `authenticated` (logged
-- in as a different user) and `anon` (no session at all); both returned the
-- victim's coaching profile and storybank. That directly contradicts README's
-- "an external visitor sees nothing".
--
-- The parameter cannot just be dropped: the edge functions call these with the
-- service-role key, where auth.uid() is NULL, so they must pass it explicitly.
-- Instead every definer function now opens with assert_self(p_user_id), which
-- allows the service-role path and pins anon/authenticated to their own uuid.
-- The `LANGUAGE sql` readers became plpgsql so they have somewhere to put it.
--
-- Also revokes the default PUBLIC execute grant on the definer set, so `anon`
-- cannot reach them at all rather than being turned away inside the body.
--
-- Behaviour for legitimate callers is unchanged: the SPA never passes
-- p_user_id (it relies on the auth.uid() default), and the edge functions pass
-- the uuid they just resolved from the caller's own JWT.
--
-- Apply in the Supabase SQL editor, then re-apply functions.sql (which carries
-- the canonical copies of every definition below).
-- ============================================================================

CREATE OR REPLACE FUNCTION assert_self(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_role text := current_setting('role', true);
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'not authorized: no user_id' USING ERRCODE = '42501';
    END IF;

    IF v_role IN ('anon', 'authenticated') AND p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'not authorized for another user' USING ERRCODE = '42501';
    END IF;

    RETURN p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_suggestions(
    p_user_id uuid DEFAULT auth.uid(),
    p_followup_days int DEFAULT 14,
    p_role_limit int DEFAULT 5,
    p_thought_limit int DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    SELECT jsonb_build_object(
        'success', true,
        'open_brain', (
            SELECT COALESCE(jsonb_agg(q.s ORDER BY q.s->>'created_at' DESC), '[]'::jsonb)
            FROM (
                SELECT jsonb_build_object(
                    'key', 'thought:' || th.id,
                    'kind', 'thought',
                    'thought_type', th.metadata->>'type',
                    'content', th.content,
                    'created_at', th.created_at
                ) AS s
                FROM thoughts th
                WHERE th.metadata @> '{"topics":["job-search"]}'::jsonb
                  AND COALESCE(th.status, '') NOT IN ('promoted', 'done')
                  AND NOT EXISTS (SELECT 1 FROM tasks t
                                  WHERE t.user_id = p_user_id AND t.thought_id = th.id)
                  AND NOT EXISTS (SELECT 1 FROM task_dismissals d
                                  WHERE d.user_id = p_user_id AND d.domain = 'job-hunt'
                                    AND d.suggestion_key = 'thought:' || th.id)
                ORDER BY CASE WHEN th.metadata->>'type' = 'task' THEN 0 ELSE 1 END,
                         th.created_at DESC
                LIMIT p_thought_limit
            ) q
        ),
        'followups', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'key', 'crm:' || c.id,
                'kind', 'followup',
                'contact_id', c.id,
                'name', c.name,
                'title', c.title,
                'organization_name', o.name,
                'follow_up_date', c.follow_up_date,
                'overdue', (c.follow_up_date <= current_date)
            ) ORDER BY c.follow_up_date ASC), '[]'::jsonb)
            FROM contacts c
            LEFT JOIN organizations o ON o.id = c.organization_id
            WHERE c.user_id = p_user_id
              AND c.tags && ARRAY['job-hunt']
              AND c.follow_up_date IS NOT NULL
              AND c.follow_up_date <= current_date + p_followup_days
              AND NOT EXISTS (SELECT 1 FROM tasks t
                              WHERE t.user_id = p_user_id AND t.contact_id = c.id
                                AND t.status IN ('open', 'snoozed'))
              AND NOT EXISTS (SELECT 1 FROM task_dismissals d
                              WHERE d.user_id = p_user_id AND d.domain = 'job-hunt'
                                AND d.suggestion_key = 'crm:' || c.id)
        ),
        'roles', (
            SELECT COALESCE(jsonb_agg(q.r ORDER BY (q.r->>'rank')::int), '[]'::jsonb)
            FROM (
                SELECT jsonb_build_object(
                    'key', 'posting:' || (role->>'id'),
                    'kind', 'apply',
                    'job_posting_id', role->>'id',
                    'title', role->>'title',
                    'organization_name', role->>'organization_name',
                    'score', role#>>'{priority,score}',
                    'rank', role->>'rank'
                ) AS r
                FROM jsonb_array_elements(
                        get_prioritized_roles(p_user_id, 7, p_role_limit) -> 'roles') role
                WHERE NOT EXISTS (SELECT 1 FROM tasks t
                                  WHERE t.user_id = p_user_id
                                    AND t.job_posting_id = (role->>'id')::uuid
                                    AND t.status IN ('open', 'snoozed'))
                  AND NOT EXISTS (SELECT 1 FROM task_dismissals d
                                  WHERE d.user_id = p_user_id AND d.domain = 'job-hunt'
                                    AND d.suggestion_key = 'posting:' || (role->>'id'))
            ) q
        )
    )
    );
END;
$$;

CREATE OR REPLACE FUNCTION promote_suggestion(
    p_suggestion_key text,
    p_priority text DEFAULT 'normal',
    p_title text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prefix text;
    v_uuid   uuid;
    v_title  text;
    v_row    tasks;
BEGIN
    PERFORM assert_self(p_user_id);
    v_prefix := split_part(p_suggestion_key, ':', 1);
    v_uuid   := split_part(p_suggestion_key, ':', 2)::uuid;

    IF v_prefix = 'thought' THEN
        v_title := COALESCE(p_title,
            left((SELECT content FROM thoughts WHERE id = v_uuid), 140), 'Job-search note');
        INSERT INTO tasks (user_id, domain, kind, title, priority, source, thought_id)
        VALUES (p_user_id, 'job-hunt', 'thought', v_title, p_priority, 'open_brain', v_uuid)
        RETURNING * INTO v_row;
        UPDATE thoughts SET status = 'promoted', status_updated_at = now()
        WHERE id = v_uuid;

    ELSIF v_prefix = 'crm' THEN
        v_title := COALESCE(p_title,
            'Follow up with ' || COALESCE((SELECT name FROM contacts WHERE id = v_uuid), 'contact'));
        INSERT INTO tasks (user_id, domain, kind, title, priority, source, contact_id, due_date)
        VALUES (p_user_id, 'job-hunt', 'followup', v_title, p_priority, 'crm', v_uuid,
                (SELECT follow_up_date FROM contacts WHERE id = v_uuid))
        RETURNING * INTO v_row;

    ELSIF v_prefix = 'posting' THEN
        -- Idempotent: the ★ Add control fires from several surfaces (Pipeline
        -- table, role page) and can be clicked when a task already exists. If an
        -- open/snoozed apply task for this posting is already on the checklist,
        -- return it instead of inserting a duplicate.
        SELECT * INTO v_row FROM tasks
         WHERE user_id = p_user_id AND domain = 'job-hunt' AND kind = 'apply'
           AND job_posting_id = v_uuid AND status IN ('open', 'snoozed')
         ORDER BY created_at LIMIT 1;
        IF NOT FOUND THEN
            v_title := COALESCE(p_title,
                'Apply — ' || COALESCE((SELECT title FROM job_postings WHERE id = v_uuid), 'role'));
            INSERT INTO tasks (user_id, domain, kind, title, priority, source, job_posting_id)
            VALUES (p_user_id, 'job-hunt', 'apply', v_title, p_priority, 'manual', v_uuid)
            RETURNING * INTO v_row;
        END IF;

    ELSE
        RAISE EXCEPTION 'promote_suggestion: unknown key prefix %', v_prefix;
    END IF;

    RETURN jsonb_build_object('success', true, 'task', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION get_interview_prep(
    p_interview_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    WITH iv AS (
        SELECT i.id, i.interview_type, i.scheduled_at, i.status,
               i.interviewer_contact_id,
               a.job_posting_id, jp.title AS role_title, jp.organization_id,
               jp.growth_stage, o.name AS organization_name,
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
                    'scheduled_at', iv.scheduled_at, 'status', iv.status),
                'role', jsonb_build_object(
                    'job_posting_id', iv.job_posting_id, 'title', iv.role_title,
                    'organization_id', iv.organization_id,
                    'organization_name', iv.organization_name),
                'company_intel', jsonb_build_object(
                    'growth_stage', iv.growth_stage,
                    'growth_signals', iv.growth_signals,
                    'growth_rationale', iv.growth_rationale,
                    'notes', (
                        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'content', n.content, 'created_at', n.created_at)), '[]'::jsonb)
                        FROM (
                            SELECT content, created_at FROM thoughts
                            WHERE metadata @> jsonb_build_object(
                                    'topics', jsonb_build_array(iv.organization_name))
                            ORDER BY created_at DESC LIMIT 5
                        ) n)),
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
                'prep_tasks', (
                    SELECT COALESCE(jsonb_agg(to_jsonb(t)
                        ORDER BY t.sort_order, t.created_at), '[]'::jsonb)
                    FROM tasks t
                    WHERE t.user_id = p_user_id AND t.interview_id = p_interview_id
                      AND t.kind = 'interview_prep')
            )
            FROM iv)
    END
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_interview_prep_session(
    p_interview_id uuid,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
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
                -- notes = the scheduling-time context (D5): the page pre-fills
                -- a fresh intake box from it; contextSeed folds it into the
                -- model prompt.
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
    END
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_story_cheat_sheet(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
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
      -- formal rounds only — enforcing the invariant 020's header claims (D3)
      AND i.category = 'interview'
      AND s.synthesis IS NOT NULL
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_coaching_profile(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    SELECT jsonb_build_object(
        'success', true,
        'profile', (SELECT to_jsonb(p) FROM coaching_profiles p WHERE p.user_id = p_user_id)
    )
    );
END;
$$;

CREATE OR REPLACE FUNCTION list_stories(
    p_competency text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    SELECT jsonb_build_object(
        'success', true,
        'stories', COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.strength DESC NULLS LAST, s.updated_at DESC), '[]'::jsonb)
    )
    FROM coaching_stories s
    WHERE s.user_id = p_user_id
      AND (p_competency IS NULL OR s.competency ILIKE p_competency)
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_score_history(
    p_limit integer DEFAULT 30,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    WITH recent AS (
        SELECT * FROM coaching_scores
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT GREATEST(COALESCE(p_limit, 30), 1)
    )
    SELECT jsonb_build_object(
        'success', true,
        'count', (SELECT count(*) FROM recent),
        'averages', (
            SELECT jsonb_build_object(
                'substance',       round(avg(substance)::numeric, 2),
                'structure',       round(avg(structure)::numeric, 2),
                'relevance',       round(avg(relevance)::numeric, 2),
                'credibility',     round(avg(credibility)::numeric, 2),
                'differentiation', round(avg(differentiation)::numeric, 2))
            FROM recent),
        -- The calibration gap: positive means the candidate rates themselves
        -- above the coach (overconfidence), negative means they undersell.
        'calibration_gap', (
            SELECT round(avg(self_score - (
                (COALESCE(substance,0) + COALESCE(structure,0) + COALESCE(relevance,0)
                 + COALESCE(credibility,0) + COALESCE(differentiation,0))::numeric
                / NULLIF((substance IS NOT NULL)::int + (structure IS NOT NULL)::int
                    + (relevance IS NOT NULL)::int + (credibility IS NOT NULL)::int
                    + (differentiation IS NOT NULL)::int, 0)
            ))::numeric, 2)
            FROM recent WHERE self_score IS NOT NULL),
        'scores', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) FROM recent r)
    )
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_question_bank(
    p_organization_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 40,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    SELECT jsonb_build_object(
        'success', true,
        'questions', COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb))
    FROM (
        SELECT * FROM coaching_questions
        WHERE user_id = p_user_id
          AND (p_organization_id IS NULL OR organization_id = p_organization_id)
        ORDER BY created_at DESC
        LIMIT GREATEST(COALESCE(p_limit, 40), 1)
    ) q
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_coaching_artifact(
    p_kind text,
    p_interview_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    SELECT jsonb_build_object(
        'success', true,
        'artifact', (
            SELECT to_jsonb(a) FROM coaching_artifacts a
            WHERE a.user_id = p_user_id AND a.kind = p_kind
              AND COALESCE(a.interview_id, '00000000-0000-0000-0000-000000000000'::uuid)
                  = COALESCE(p_interview_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    );
END;
$$;

CREATE OR REPLACE FUNCTION get_coaching_context(
    p_interview_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM assert_self(p_user_id);
    RETURN (
    WITH org AS (
        SELECT jp.organization_id
        FROM interviews i
        JOIN applications a ON a.id = i.application_id
        JOIN job_postings jp ON jp.id = a.job_posting_id
        WHERE p_interview_id IS NOT NULL
          AND i.id = p_interview_id AND i.user_id = p_user_id
    )
    SELECT jsonb_build_object(
        'success', true,
        'profile', (SELECT to_jsonb(p) FROM coaching_profiles p WHERE p.user_id = p_user_id),
        -- Strongest stories first; the prompt only needs the top slice, not
        -- the whole bank, or the storybank crowds out the actual task.
        'stories', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', s.id, 'title', s.title, 'competency', s.competency,
                'situation', s.situation, 'task', s.task, 'action', s.action,
                'result', s.result, 'earned_secret', s.earned_secret,
                'strength', s.strength, 'best_for', s.best_for,
                'last_used_at', s.last_used_at) ORDER BY s.strength DESC NULLS LAST), '[]'::jsonb)
            FROM (
                SELECT * FROM coaching_stories
                WHERE user_id = p_user_id
                ORDER BY strength DESC NULLS LAST, updated_at DESC
                LIMIT 12
            ) s),
        'story_count', (SELECT count(*) FROM coaching_stories WHERE user_id = p_user_id),
        -- Competencies with no story at all, or only a weak one — this is what
        -- turns "you have 8 stories" into "you have no story for conflict".
        'weak_competencies', (
            SELECT COALESCE(jsonb_agg(competency), '[]'::jsonb)
            FROM coaching_stories
            WHERE user_id = p_user_id AND competency IS NOT NULL
              AND COALESCE(strength, 0) <= 2),
        'score_summary', get_score_history(12, p_user_id),
        'question_bank', get_question_bank(
            (SELECT organization_id FROM org), 25, p_user_id)
    )
    );
END;
$$;


GRANT EXECUTE ON FUNCTION assert_self(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION get_suggestions(uuid, int, int, int)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION promote_suggestion(text, text, text, uuid)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_interview_prep(uuid, uuid)                FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_interview_prep_session(uuid, uuid)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_story_cheat_sheet(uuid)                   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_coaching_profile(uuid)                    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION list_stories(text, uuid)                      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_score_history(integer, uuid)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_question_bank(uuid, integer, uuid)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_coaching_artifact(text, uuid, uuid)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_coaching_context(uuid, uuid)              FROM PUBLIC;
