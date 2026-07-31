import { useEffect, useState } from "react";
import { fetchOrgContacts, scheduleInterview } from "../lib/api";
import type { InterviewCategory } from "../lib/types";

// The full "add a round" control (T1.3). schedule_interview has accepted
// interview_type / category / duration / interviewer since migration 020 —
// this form finally collects them, so rounds created in the app are typed
// (furthest_round works, the dedup key is precise) and networking calls are
// creatable outside of chat. Attach to an application (role page, queue) or,
// with organizationId instead, to a company (Company page → log a call).

// interviews.interview_type CHECK constraint, verbatim (schema.sql).
const INTERVIEW_TYPES = [
  "phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final",
] as const;
const NETWORKING_TYPES = ["recruiter_call", "networking_call", "coffee_chat", "informational"] as const;

const label = (t: string) => t.replace(/_/g, " ");

export default function ScheduleInterviewForm({
  applicationId,
  organizationId,
  defaultCategory = "interview",
  onScheduled,
  startOpen = false,
  onCancel,
}: {
  // Exactly one of these is required (mirrors schedule_interview's contract):
  // an application for a formal round, an organization for a standalone call.
  applicationId?: string;
  organizationId?: string;
  defaultCategory?: InterviewCategory;
  onScheduled: () => void;
  // Skip the "+ Schedule interview…" toggle and render the form expanded —
  // for callers (e.g. a quick-add flow) where the open intent is already given.
  startOpen?: boolean;
  // Called when Cancel is clicked while startOpen — lets the caller collapse
  // its own wrapping panel instead of just re-showing the toggle button.
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [category, setCategory] = useState<InterviewCategory>(defaultCategory);
  const [type, setType] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [interviewerId, setInterviewerId] = useState("");
  const [contacts, setContacts] = useState<Array<{ id: string; name: string; title: string | null }> | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the company's people for the interviewer picker only once the form is
  // actually open — most renders of the collapsed button never need it.
  useEffect(() => {
    if (!open || contacts !== null) return;
    fetchOrgContacts({ organizationId, applicationId })
      .then(setContacts)
      .catch(() => setContacts([])); // picker is optional — don't block the form
  }, [open, contacts, organizationId, applicationId]);

  const typeOptions = category === "networking" ? NETWORKING_TYPES : INTERVIEW_TYPES;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Deliberately "${date}T${time}" with no offset, never a bare date: a
      // date-only string parses as UTC midnight (new Date("2026-07-20") is
      // 2026-07-20T00:00Z), which then renders hours earlier in any zone west
      // of UTC — the "tomorrow shows up as tonight" bug. A date+time string
      // with no offset parses as local time, which is what the inputs mean.
      const scheduledAt = date ? new Date(`${date}T${time || "00:00"}`).toISOString() : undefined;
      const { created } = await scheduleInterview({
        applicationId,
        organizationId: applicationId ? undefined : organizationId,
        category,
        scheduledAt,
        interviewType: type || undefined,
        durationMinutes: duration ? Number(duration) : undefined,
        interviewerContactId: interviewerId || undefined,
        notes: notes.trim() || undefined,
      });
      // schedule_interview find-or-creates, so a double-submit is harmless —
      // but say so rather than silently looking like it worked twice.
      if (!created) {
        setError("That round was already on the books — nothing added.");
        return;
      }
      setOpen(false);
      setType("");
      setDate("");
      setTime("");
      setDuration("");
      setInterviewerId("");
      setNotes("");
      onScheduled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="ghost sm" onClick={() => setOpen(true)}>
        {defaultCategory === "networking" ? "+ Log a networking call…" : "+ Schedule interview…"}
      </button>
    );
  }

  return (
    <div className="schedule-interview-form">
      <div className="schedule-interview-datetime">
        <label className="muted small">
          Kind
          <select
            value={category}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as InterviewCategory;
              setCategory(next);
              setType(""); // the type list changes with the category
            }}
          >
            <option value="interview">Interview round</option>
            <option value="networking">Networking call</option>
          </select>
        </label>
        <label className="muted small">
          Type
          <select value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{label(t)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="schedule-interview-datetime">
        <label className="muted small">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
        </label>
        <label className="muted small">
          Time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={busy} />
        </label>
        <label className="muted small">
          Minutes
          <input
            type="number"
            min={5}
            step={5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="45"
            style={{ width: "4.5rem" }}
            disabled={busy}
          />
        </label>
      </div>
      {(contacts?.length ?? 0) > 0 && (
        <label className="muted small">
          With
          <select value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {contacts!.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.title ? ` · ${c.title}` : ""}</option>
            ))}
          </select>
        </label>
      )}
      <label className="muted small">
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="what to expect, who's involved, prep reminders…"
          disabled={busy}
        />
      </label>
      <div className="schedule-interview-actions">
        <button className="sm" disabled={busy} onClick={save}>{busy ? "…" : "Save"}</button>
        <button
          className="ghost sm"
          disabled={busy}
          onClick={() => { setOpen(false); setError(null); onCancel?.(); }}
        >
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
