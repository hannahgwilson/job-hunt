import { useState, type FormEvent } from "react";
import { sendInterviewPrepMessage, requestInterviewPrepFeedback, requestInterviewPrepDraftFeedback } from "../lib/api";
import type { InterviewPrepMessage, InterviewPrepFeedback } from "../lib/types";

const KIND_LABEL: Record<string, string> = {
  interviewer: "Interviewer",
  user: "You",
};

function parseFeedback(content: string): InterviewPrepFeedback | null {
  try { return JSON.parse(content) as InterviewPrepFeedback; }
  catch { return null; }
}

function ratingPillClass(rating: string) {
  return rating === "strong" || rating === "solid" ? "pill-accepted" : "pill-warn";
}

function FeedbackBody({ fb }: { fb: InterviewPrepFeedback }) {
  return (
    <>
      {fb.what_worked.length > 0 && <p className="small"><strong>Worked:</strong> {fb.what_worked.join(" · ")}</p>}
      {fb.what_to_improve.length > 0 && <p className="small"><strong>Improve:</strong> {fb.what_to_improve.join(" · ")}</p>}
      {fb.suggested_rewrite && <p className="muted small"><em>Try:</em> {fb.suggested_rewrite}</p>}
    </>
  );
}

// The live mock-interview rehearsal: the AI plays the researched
// interviewer(s), you answer in the input below. Two distinct feedback paths
// share one draft box:
//   - Draft workshop: while you're still typing/revising an answer, "Get
//     feedback on this draft" critiques it WITHOUT sending it — nothing is
//     persisted, so you can iterate on wording as many times as you like.
//   - Committed feedback: once the box is empty (you've already sent an
//     answer), the same button critiques your last SENT answer and logs it
//     to the transcript — this is the persisted history in the section below.
export default function InterviewPrepChat({
  interviewId,
  transcript,
  onChanged,
}: {
  interviewId: string;
  transcript: InterviewPrepMessage[];
  onChanged: (transcript: InterviewPrepMessage[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [gettingFeedback, setGettingFeedback] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(true);
  const [draftFeedback, setDraftFeedback] = useState<InterviewPrepFeedback | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const dialogue = transcript.filter((m) => m.kind !== "coach_feedback");
  const feedbackEntries = transcript.filter((m) => m.kind === "coach_feedback");
  const hasAnyUserTurn = transcript.some((m) => m.kind === "user");
  const isDraft = draft.trim().length > 0;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const message = draft.trim();
    setSending(true); setErr(null);
    try {
      const fresh = await sendInterviewPrepMessage(interviewId, message || undefined);
      setDraft("");
      setDraftFeedback(null);
      onChanged(fresh.session?.transcript ?? []);
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setSending(false); }
  }

  async function feedback() {
    setGettingFeedback(true); setErr(null);
    try {
      if (isDraft) {
        const result = await requestInterviewPrepDraftFeedback(interviewId, draft.trim());
        setDraftFeedback(result.feedback ?? null);
      } else {
        const fresh = await requestInterviewPrepFeedback(interviewId);
        onChanged(fresh.session?.transcript ?? []);
        setFeedbackOpen(true);
      }
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setGettingFeedback(false); }
  }

  function useRewrite() {
    if (draftFeedback?.suggested_rewrite) {
      setDraft(draftFeedback.suggested_rewrite);
      setDraftFeedback(null);
    }
  }

  return (
    <div className="prep-chat">
      <div className="prep-chat-log">
        {dialogue.length === 0 && (
          <p className="muted small">No rehearsal yet — start the mock interview below.</p>
        )}
        {dialogue.map((m) => (
          <div key={m.id} className={`prep-msg prep-msg-${m.kind}`}>
            <div className="prep-msg-head">{KIND_LABEL[m.kind]}</div>
            <p>{m.content}</p>
          </div>
        ))}
      </div>

      {err && <p className="error small">{err}</p>}

      <form className="prep-chat-input" onSubmit={send}>
        <textarea
          rows={3}
          placeholder={dialogue.length === 0 ? "Ready when you are — send anything to start the interview…" : "Your answer… (workshop it — get feedback before you send)"}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDraftFeedback(null); }}
        />

        {draftFeedback && (
          <div className="prep-feedback-card draft">
            <div className="prep-msg-head">
              <span className="pill">draft</span>
              <span className={`pill ${ratingPillClass(draftFeedback.rating)}`}>{draftFeedback.rating}</span>
            </div>
            <FeedbackBody fb={draftFeedback} />
            {draftFeedback.suggested_rewrite && (
              <button type="button" className="ghost sm" onClick={useRewrite}>Use this rewrite</button>
            )}
          </div>
        )}

        <div className="prep-chat-actions">
          <button type="submit" disabled={sending}>
            {sending ? "…" : dialogue.length === 0 ? "Start mock interview" : "Send"}
          </button>
          <button
            type="button"
            className="ghost sm"
            disabled={gettingFeedback || (!isDraft && !hasAnyUserTurn)}
            onClick={feedback}
            title={isDraft ? "Critique this draft — nothing is sent" : !hasAnyUserTurn ? "Answer a question first" : "Critique my last answer"}
          >
            {gettingFeedback ? "…" : isDraft ? "Get feedback on this draft" : "Get feedback on my last answer"}
          </button>
        </div>
      </form>

      {feedbackEntries.length > 0 && (
        <div className="prep-feedback-section">
          <button type="button" className="ghost sm" onClick={() => setFeedbackOpen((o) => !o)}>
            {feedbackOpen ? "Hide" : "Show"} coach feedback <span className="count">{feedbackEntries.length}</span>
          </button>
          {feedbackOpen && (
            <div className="prep-feedback-list">
              {feedbackEntries.slice().reverse().map((m, i) => {
                const fb = parseFeedback(m.content);
                const answer = transcript.find((t) => t.id === m.in_reply_to);
                return (
                  <div key={m.id} className={`prep-feedback-card${i === 0 ? " latest" : ""}`}>
                    <div className="prep-msg-head">
                      {i === 0 && <span className="pill">latest</span>}
                      {fb && <span className={`pill ${ratingPillClass(fb.rating)}`}>{fb.rating}</span>}
                    </div>
                    {answer && <p className="prep-feedback-quote small">"{answer.content}"</p>}
                    {fb ? <FeedbackBody fb={fb} /> : <p className="small">{m.content}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
