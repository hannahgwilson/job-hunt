-- 027_thoughts_owner.sql — close D8: the thoughts leak across auth users.
--
-- `thoughts` is Open Brain's table and shipped with NO owner column, so every
-- job-hunt reader of it was scoped by nothing at all. Four SECURITY DEFINER
-- functions read or wrote it — get_suggestions, promote_suggestion,
-- get_interview_prep, get_interview_prep_session — which meant any signed-in
-- account (the demo one included) saw every user's job-search notes on the
-- Action Queue and on every prep page. Confirmed live 2026-08-18: signed in as
-- demo, "Suggested" listed 12 real notes with named contacts.
--
-- The fix is the column the table never had, plus an owner predicate on every
-- read. assert_self (migration 025) already stops a caller passing someone
-- else's uuid; this stops the rows themselves being unscoped.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- BEFORE YOU RUN THIS, read the two operator steps below. Step 2 is not
-- optional — without it your own Suggested list goes empty.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The column, plus the index the filtered reads now need.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS thoughts_user_id_created_idx
    ON thoughts (user_id, created_at DESC);

-- 2. OPERATOR STEP — backfill, and keep new rows populated.
--
--    Existing rows have user_id NULL, and a NULL owner now matches nobody, so
--    until this runs every Suggested list is empty. Open Brain's own writers
--    (capture, the entity-extraction worker) live outside this repo and do not
--    know about this column yet, so the DEFAULT is what keeps newly captured
--    thoughts visible here until they do. Both statements need your auth uid,
--    which is why they are not committed filled in — this repo is public.
--
--      SELECT id, email FROM auth.users;   -- yours, not the demo account's
--
--      UPDATE thoughts SET user_id = '<YOUR-AUTH-UID>'::uuid WHERE user_id IS NULL;
--      ALTER TABLE thoughts ALTER COLUMN user_id SET DEFAULT '<YOUR-AUTH-UID>'::uuid;
--
--    The DEFAULT is a stopgap with a real expiry: it is wrong the moment a
--    second person writes to Open Brain. The durable fix is for Open Brain's
--    writers to set user_id themselves, at which point drop the default.

-- 3. The four readers, re-declared with the owner predicate.

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
                WHERE th.user_id = p_user_id
                  AND th.metadata @> '{"topics":["job-search"]}'::jsonb
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
            left((SELECT content FROM thoughts
                  WHERE id = v_uuid AND user_id = p_user_id), 140), 'Job-search note');
        INSERT INTO tasks (user_id, domain, kind, title, priority, source, thought_id)
        VALUES (p_user_id, 'job-hunt', 'thought', v_title, p_priority, 'open_brain', v_uuid)
        RETURNING * INTO v_row;
        UPDATE thoughts SET status = 'promoted', status_updated_at = now()
        WHERE id = v_uuid AND user_id = p_user_id;

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
                            WHERE user_id = p_user_id
                              AND metadata @> jsonb_build_object(
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
               o.growth_signals, o.growth_rationale,
               -- The flag, not the body: the prep page only needs to know
               -- whether the JD decode can run without a paste (migration 026).
               jp.has_jd_text
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
                    'organization_name', iv.organization_name,
                    'has_jd_text', iv.has_jd_text),
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
                        WHERE user_id = p_user_id
                          AND metadata @> jsonb_build_object(
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
