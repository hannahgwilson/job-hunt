import { useState } from "react";
import { completeInterview } from "../lib/api";
import type { AdvanceDecision, Interview, InterviewStatus } from "../lib/types";

// Close out one interview round. Two paths, both landing on complete_interview:
//
//   * Cancelled / No-show — one click, nothing to reflect on.
//   * Done — opens the debrief (rating, how it went, and the go/no-go). The
//     rating and decision are optional; "Done" with an empty form is a valid
//     answer and still moves it off 'scheduled', which is the whole point.
//
// Renders as a read-only summary once the round is no longer 'scheduled', with
// a Reopen escape hatch for mis-clicks.

const DECISIONS: { value: AdvanceDecision; label: string; hint: string }[] = [
  { value: "advance", label: "Advance", hint: "Moving to the next round" },
  { value: "hold", label: "Hold", hint: "Waiting / undecided" },
  { value: "withdraw", label: "Withdraw", hint: "I'm pulling out" },
  { value: "rejected", label: "Rejected", hint: "They passed" },
];

export default function InterviewOutcome({
  interview,
  onChanged,
}: {
  interview: Interview;
  onChanged: (updated: Interview) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(interview.rating);
  const [feedback, setFeedback] = useState(interview.feedback ?? "");
  const [decision, setDecision] = useState<AdvanceDecision | null>(interview.advance_decision);
  const [decisionNotes, setDecisionNotes] = useState(interview.decision_notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(status: InterviewStatus, withDebrief = false) {
    setBusy(true);
    setError(null);
    try {
      const updated = await completeInterview({
        interviewId: interview.id,
        status,
        // Only send the debrief from the expanded form — the quick Cancelled /
        // No-show buttons must not smuggle in half-typed form state.
        rating: withDebrief ? rating ?? undefined : undefined,
        feedback: withDebrief ? feedback.trim() || undefined : undefined,
        advanceDecision: withDebrief ? decision ?? undefined : undefined,
        decisionNotes: withDebrief ? decisionNotes.trim() || undefined : undefined,
      });
      setOpen(false);
      onChanged(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (interview.status !== "scheduled" && !open) {
    return (
      <div className="iv-actions">
        {/* Amend a finished round in place (T1.4) — same debrief form, same
            complete_interview call, keeping whatever terminal status it has. */}
        <button className="ghost sm" disabled={busy} onClick={() => setOpen(true)}>
          Edit debrief…
        </button>
        <button className="ghost sm" disabled={busy} onClick={() => set("scheduled")}>
          Reopen
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="iv-actions">
        <button className="sm" disabled={busy} onClick={() => setOpen(true)}>Done…</button>
        <button className="ghost sm" disabled={busy} onClick={() => set("cancelled")} title="It didn't happen">
          Cancelled
        </button>
        <button className="ghost sm" disabled={busy} onClick={() => set("no_show")} title="Nobody showed">
          No-show
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  }

  return (
    <div className="iv-debrief">
      <label className="muted small">
        How did it go?
        <span className="iv-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`iv-star${rating != null && n <= rating ? " on" : ""}`}
              disabled={busy}
              aria-label={`${n} of 5`}
              onClick={() => setRating(rating === n ? null : n)}
            >
              ★
            </button>
          ))}
        </span>
      </label>

      <label className="muted small">
        Notes
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={3}
          placeholder="what came up, what you'd answer differently, who you met…"
          disabled={busy}
        />
      </label>

      <fieldset className="iv-decision">
        <legend className="muted small">Do you move forward?</legend>
        {DECISIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            className={`ghost sm${decision === d.value ? " on" : ""}`}
            title={d.hint}
            disabled={busy}
            onClick={() => setDecision(decision === d.value ? null : d.value)}
          >
            {d.label}
          </button>
        ))}
      </fieldset>

      {decision && (
        <label className="muted small">
          Why
          <input
            value={decisionNotes}
            onChange={(e) => setDecisionNotes(e.target.value)}
            placeholder="one line for future you"
            disabled={busy}
          />
        </label>
      )}

      <div className="iv-debrief-actions">
        <button
          className="sm"
          disabled={busy}
          // Editing a finished round keeps its terminal status; debriefing a
          // scheduled one is what moves it to 'completed'.
          onClick={() => set(interview.status === "scheduled" ? "completed" : interview.status, true)}
        >
          {busy ? "…" : interview.status === "scheduled" ? "Mark completed" : "Save debrief"}
        </button>
        <button className="ghost sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
