import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchInterviews } from "../lib/api";
import type { InterviewListRow } from "../lib/types";

// All-up list of every interview across every application — upcoming first
// (soonest on top), then past (most recent first). RoleDetail shows the same
// rows scoped to one application; this is the cross-role view.

const DECISION_PILL: Record<string, string> = {
  advance: "pill-accepted",
  hold: "pill-warn",
  withdraw: "pill-withdrawn",
  rejected: "pill-rejected",
};

function Row({ iv }: { iv: InterviewListRow }) {
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
        <span className="muted"> · {iv.status}</span>
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
    </div>
  );
}

export default function Interviews() {
  const [interviews, setInterviews] = useState<InterviewListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchInterviews().then(setInterviews).catch((e) => setError(e.message));
  }, []);

  const { upcoming, past } = useMemo(() => {
    const now = new Date().toISOString();
    const rows = interviews ?? [];
    const upcoming = rows
      .filter((iv) => iv.scheduled_at && iv.scheduled_at >= now && iv.status !== "cancelled")
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
    const past = rows
      .filter((iv) => !upcoming.includes(iv))
      .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") * -1);
    return { upcoming, past };
  }, [interviews]);

  if (error) return <p className="error">{error}</p>;
  if (!interviews) return <p className="muted">Loading…</p>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Interviews</h1>
        <Link to="/cheat-sheet" className="ghost sm">Cheat sheet →</Link>
      </div>

      <section className="card">
        <h2>Upcoming <span className="muted small">· {upcoming.length}</span></h2>
        {upcoming.length === 0 && <p className="muted">None scheduled.</p>}
        {upcoming.map((iv) => <Row key={iv.id} iv={iv} />)}
      </section>

      <section className="card">
        <h2>Past <span className="muted small">· {past.length}</span></h2>
        {past.length === 0 && <p className="muted">No past interviews yet.</p>}
        {past.map((iv) => <Row key={iv.id} iv={iv} />)}
      </section>
    </div>
  );
}
