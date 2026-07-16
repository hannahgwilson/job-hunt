import { useState } from "react";
import { scheduleInterview } from "../lib/api";

// Minimal "add an interview" control for the role page: a date + free-text
// notes, nothing more. (schedule_interview also takes interview_type,
// interviewer_contact_id, and an add_to_calendar bridge — those stay
// MCP/agent-only for now, since intake there happens conversationally.)
export default function ScheduleInterviewForm({
  applicationId,
  onScheduled,
}: {
  applicationId: string;
  onScheduled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await scheduleInterview({
        applicationId,
        scheduledAt: date ? new Date(date).toISOString() : undefined,
        notes: notes.trim() || undefined,
      });
      setOpen(false);
      setDate("");
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
      <button className="ghost sm" onClick={() => setOpen(true)}>+ Schedule interview…</button>
    );
  }

  return (
    <div className="schedule-interview-form">
      <label className="muted small">
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
      </label>
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
        <button className="ghost sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
