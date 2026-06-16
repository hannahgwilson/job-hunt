import { useEffect, useState } from "react";
import { fetchActionQueue } from "../lib/api";
import type { ActionQueue as Q, PriorityComponents, RankedRole } from "../lib/types";

const COMPONENT_LABELS: Array<[keyof PriorityComponents, string]> = [
  ["experience", "Fit"],
  ["location", "Location"],
  ["comp", "Comp"],
  ["career", "Career"],
  ["growth", "Growth"],
];

function scoreClass(score: number): string {
  if (score >= 70) return "score-high";
  if (score >= 45) return "score-mid";
  return "score-low";
}

function PriorityRow({ role }: { role: RankedRole }) {
  const { score, components } = role.priority;
  return (
    <li className="ranked-role">
      <div className="ranked-role-head">
        <span className="rank">#{role.rank}</span>
        <span className={`score-badge ${scoreClass(score)}`}>{score}</span>
        <span className="ranked-role-title">
          <strong>{role.title}</strong> @ {role.organization_name}
          {role.closing_soon && <span className="pill pill-warn">closing soon</span>}
          {role.url && <a href={role.url} target="_blank" rel="noreferrer"> ↗</a>}
        </span>
      </div>
      <div className="priority-bars" title="Component fit (0–1), see semantic/metrics/priority_score.yaml">
        {COMPONENT_LABELS.map(([key, label]) => (
          <div key={key} className="priority-bar">
            <span className="priority-bar-label">{label}</span>
            <span className="priority-bar-track">
              <span className="priority-bar-fill" style={{ width: `${components[key] * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
    </li>
  );
}

export default function ActionQueue() {
  const [q, setQ] = useState<Q | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActionQueue().then(setQ).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!q) return <p className="muted">Loading…</p>;

  return (
    <div className="page">
      <h1>Action Queue</h1>
      <div className="queue-grid">
        <section className="card span-2">
          <h2>
            Roles to apply <span className="count">{q.roles_to_apply.length}</span>
            <span className="muted small"> — force-ranked by priority</span>
          </h2>
          <ul className="clean">
            {q.roles_to_apply.map((r) => (
              <PriorityRow key={r.id} role={r} />
            ))}
            {q.roles_to_apply.length === 0 && <li className="muted">Nothing waiting.</li>}
          </ul>
        </section>

        <section className="card">
          <h2>Follow-ups <span className="count">{q.role_followups.length}</span></h2>
          <ul className="clean">
            {q.role_followups.map((f) => (
              <li key={f.application_id}>
                <strong>{f.title}</strong> @ {f.organization_name}
                <span className="muted"> — {f.status}, {f.days_waiting ?? "?"}d waiting</span>
              </li>
            ))}
            {q.role_followups.length === 0 && <li className="muted">All caught up.</li>}
          </ul>
        </section>

        <section className="card">
          <h2>Upcoming interviews <span className="count">{q.upcoming_interviews.length}</span></h2>
          <ul className="clean">
            {q.upcoming_interviews.map((i) => (
              <li key={i.interview_id}>
                <strong>{i.title}</strong> @ {i.organization_name}
                <span className="muted"> — {i.interview_type} · {new Date(i.scheduled_at).toLocaleString()}</span>
              </li>
            ))}
            {q.upcoming_interviews.length === 0 && <li className="muted">None scheduled.</li>}
          </ul>
        </section>

        <section className="card">
          <h2>Networking <span className="count">{q.networking.length}</span></h2>
          <ul className="clean">
            {q.networking.map((c) => (
              <li key={c.contact_id}>
                <strong>{c.name}</strong>{c.title ? `, ${c.title}` : ""}
                {c.organization_name && <span className="muted"> @ {c.organization_name}</span>}
                <span className="muted"> — {c.last_contacted ? `last ${c.last_contacted}` : "never contacted"}</span>
              </li>
            ))}
            {q.networking.length === 0 && <li className="muted">No stale contacts.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
