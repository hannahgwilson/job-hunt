import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchRole } from "../lib/api";
import type { Application, Interview, StatusHistoryRow } from "../lib/types";

const DECISION_PILL: Record<string, string> = {
  advance: "pill-accepted",
  hold: "pill-warn",
  withdraw: "pill-withdrawn",
  rejected: "pill-rejected",
};

export default function RoleDetail() {
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<Application | null>(null);
  const [history, setHistory] = useState<StatusHistoryRow[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchRole(id)
      .then((r) => { setApp(r.application); setHistory(r.history); setInterviews(r.interviews); })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!app) return <p className="muted">Loading…</p>;

  const posting = app.job_postings;

  return (
    <div className="page">
      <p><Link to="/pipeline">← Pipeline</Link></p>
      <div className="page-head">
        <h1>{posting?.title}</h1>
        <span className={`pill pill-${app.status}`}>{app.status}</span>
      </div>
      <p className="muted">
        {posting?.organizations?.name}
        {posting?.location ? ` · ${posting.location}` : ""}
        {posting?.remote_policy ? ` · ${posting.remote_policy}` : ""}
        {posting?.url && <> · <a href={posting.url} target="_blank" rel="noreferrer">posting ↗</a></>}
      </p>

      <div className="cols">
        <section className="card">
          <h2>Stage history</h2>
          <ol className="timeline">
            {history.map((h) => (
              <li key={h.id}>
                <span className="ts muted">{new Date(h.changed_at).toLocaleDateString()}</span>
                <span>{h.from_status ? `${h.from_status} → ` : ""}<strong>{h.to_status}</strong></span>
                {h.notes && <div className="muted small">{h.notes}</div>}
              </li>
            ))}
            {history.length === 0 && <li className="muted">No transitions yet.</li>}
          </ol>
        </section>

        <section className="card">
          <h2>Interviews</h2>
          {interviews.length === 0 && <p className="muted">None scheduled.</p>}
          {interviews.map((iv) => (
            <div key={iv.id} className="interview">
              <div className="iv-head">
                <strong>{iv.interview_type ?? "Interview"}</strong>
                <span className="muted">{iv.scheduled_at ? new Date(iv.scheduled_at).toLocaleString() : "unscheduled"}</span>
              </div>
              <div className="iv-meta">
                <span className="muted">{iv.status}</span>
                {iv.rating != null && <span> · {"★".repeat(iv.rating)}</span>}
                {iv.advance_decision && (
                  <span className={`pill ${DECISION_PILL[iv.advance_decision] ?? ""}`}>{iv.advance_decision}</span>
                )}
              </div>
              {iv.feedback && <p className="small">{iv.feedback}</p>}
              {iv.decision_notes && <p className="muted small">Decision: {iv.decision_notes}</p>}
            </div>
          ))}
        </section>
      </div>

      {app.notes && (
        <section className="card"><h2>Notes</h2><p>{app.notes}</p></section>
      )}
    </div>
  );
}
