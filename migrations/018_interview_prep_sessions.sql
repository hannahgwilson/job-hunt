-- Migration 018: interview_prep_sessions — the AI-written prep flow
--
-- Round two of docs/checklist-feature-discovery.md Feature 3 ("v1 static
-- assembly" -> AI prep brief). One row per interview (interviews are already
-- per-round, so this maps 1:1 onto "prep for this specific meeting"):
-- intake notes -> AI research on the people/role -> a live mock-interview
-- chat transcript (incl. out-of-character coach feedback) -> a synthesized
-- bulleted summary (stories / competencies / questions to ask).
--
-- Same boilerplate as resume_feedback_synthesis (schema.sql): index,
-- updated_at trigger, RLS policy. Derived/session data — safe to delete and
-- regenerate. After applying, (re)apply functions.sql for the five new RPCs
-- (get_interview_prep_session, start_interview_prep,
-- save_interview_prep_research, save_interview_prep_transcript,
-- save_interview_prep_synthesis).

CREATE TABLE IF NOT EXISTS interview_prep_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,

    intake_notes TEXT,             -- what the interview covers (user text or an OB thought)
    source_thought_id TEXT,         -- soft ref to Open Brain, mirrors tasks.thought_id

    research JSONB,                -- { role_summary, role_functions[], people[], prep_focus[] }
    research_model TEXT,
    research_generated_at TIMESTAMPTZ,

    transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{ id, kind: 'interviewer'|'user'|'coach_feedback', content, in_reply_to, created_at }]

    synthesis JSONB,               -- { stories[], competencies[], questions_to_ask[] }
    synthesis_model TEXT,
    synthesized_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (interview_id)
);

CREATE INDEX IF NOT EXISTS idx_interview_prep_sessions_user ON interview_prep_sessions(user_id);

DROP TRIGGER IF EXISTS update_interview_prep_sessions_updated_at ON interview_prep_sessions;
CREATE TRIGGER update_interview_prep_sessions_updated_at
    BEFORE UPDATE ON interview_prep_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE interview_prep_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interview_prep_sessions_user_policy ON interview_prep_sessions;
CREATE POLICY interview_prep_sessions_user_policy ON interview_prep_sessions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
