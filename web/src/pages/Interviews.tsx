import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { completeInterview, fetchInterviews } from "../lib/api";
import InterviewOutcome from "../components/InterviewOutcome";
import type { Interview, InterviewListRow } from "../lib/types";

// All-up list of every interview across every application. Split by OUTCOME,
// not just by clock:
//
//   Upcoming      — still 'scheduled', still in the future. Soonest first.
//   Needs debrief — still 'scheduled' but the date has passed. The nag list:
//                   these are rounds that happened and were never closed out,
//                   and they're what makes the page look full of duplicates.
//   Past          — completed / cancelled / no_show. Most recent first.
//
// Before this split the page keyed off scheduled_at alone, so a finished round
// and a forgotten one were indistinguishable and both piled up forever.
// RoleDetail shows the same rows scoped to one application.

const DECISION_PILL: Record<string, string> = {
  advance: "pill-accepted",
  hold: "pill-warn",
  withdraw: "pill-withdrawn",
  rejected: "pill-rejected",
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: "scheduled",
  completed: "completed",
  cancelled: "cancelled",
  no_show: "no-show",
};

function Row({ iv, onChanged }: { iv: InterviewListRow; onChanged: (u: Interview) => void }) {
  return (
    <div className="interview">
      <div className="iv-head">
        <strong>
          <Link to={`/company/${iv.organization_id}`}>{iv.organization_name}</Link>
          {" — "}
          <Link to={`/role/${iv.application_id}`}>{iv.role_title}</Link>
        </strong>
        <span className="muted">{iv.scheduled_at ? new Date(iv.scheduled_at).toLocaleString() : "unscheduled"}</span>
      </div>
      <div className="iv-meta">
        <span className="pill">{iv.interview_type ?? "interview"}</span>
        <span className="muted"> · {STATUS_LABEL[iv.status] ?? iv.status}</span>
        {iv.rating != null && <span> · {"★".repeat(iv.rating)}</span>}
        {iv.advance_decision && (
          <span className={`pill ${DECISION_PILL[iv.advance_decision] ?? ""}`}>{iv.advance_decision}</span>
        )}
      </div>
      {iv.notes && <p className="muted small">{iv.notes}</p>}
      {iv.feedback && <p className="small">{iv.feedback}</p>}
      {iv.decision_notes && <p className="muted small">Decision: {iv.decision_notes}</p>}
      <p className="small">
        <Link to={`/interview-prep/${iv.id}`}>Prep →</Link>
      </p>
      <InterviewOutcome interview={iv} onChanged={onChanged} />
    </div>
  );
}

export default function Interviews() {
  const [interviews, setInterviews] = useState<InterviewListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(() => {
    fetchInterviews().then(setInterviews).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // Patch one row in place rather than refetching the whole list — keeps the
  // section a row is sitting in from jumping out from under the cursor mid-edit.
  const patch = useCallback((updated: Interview) => {
    setInterviews((cur) =>
      (cur ?? []).map((iv) => (iv.id === updated.id ? { ...iv, ...updated } : iv)),
    );
  }, []);

  const { upcoming, needsDebrief, past } = useMemo(() => {
    const now = new Date().toISOString();
    const rows = interviews ?? [];
    const open = rows.filter((iv) => iv.status === "scheduled");
    return {
      upcoming: open
        .filter((iv) => iv.scheduled_at && iv.scheduled_at >= now)
        .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1)),
      // Undated rounds land here too — an interview with no date that was never
      // closed out is exactly as much of a loose end as an overdue one.
      needsDebrief: open
        .filter((iv) => !iv.scheduled_at || iv.scheduled_at < now)
        .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? "")),
      past: rows
        .filter((iv) => iv.status !== "scheduled")
        .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? "")),
    };
  }, [interviews]);

  // Bulk escape hatch for the backlog: mark every overdue round completed with
  // no debrief. Deliberately status-only — sweeping in a rating or a go/no-go
  // you didn't actually think about would poison the funnel metrics.
  async function sweepPast() {
    setSweeping(true);
    setError(null);
    try {
      const updated = await Promise.all(
        needsDebrief.map((iv) => completeInterview({ interviewId: iv.id, status: "completed" })),
      );
      updated.forEach(patch);
    } catch (e) {
      setError((e as Error).message);
      load();
    } finally {
      setSweeping(false);
    }
  }

  if (error && !interviews) return <p className="error">{error}</p>;
  if (!interviews) return <p className="muted">Loading…</p>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Interviews</h1>
        <Link to="/cheat-sheet" className="ghost sm">Cheat sheet →</Link>
      </div>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Upcoming <span className="muted small">· {upcoming.length}</span></h2>
        {upcoming.length === 0 && <p className="muted">None scheduled.</p>}
        {upcoming.map((iv) => <Row key={iv.id} iv={iv} onChanged={patch} />)}
      </section>

      {needsDebrief.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h2>Needs debrief <span className="muted small">· {needsDebrief.length}</span></h2>
            <button className="ghost sm" disabled={sweeping} onClick={sweepPast}>
              {sweeping ? "…" : "Mark all completed"}
            </button>
          </div>
          <p className="muted small">
            These dates have passed but the rounds were never closed out — they still count as
            pending on the Dashboard.
          </p>
          {needsDebrief.map((iv) => <Row key={iv.id} iv={iv} onChanged={patch} />)}
        </section>
      )}

      <section className="card">
        <h2>Past <span className="muted small">· {past.length}</span></h2>
        {past.length === 0 && <p className="muted">No past interviews yet.</p>}
        {past.map((iv) => <Row key={iv.id} iv={iv} onChanged={patch} />)}
      </section>
    </div>
  );
}
