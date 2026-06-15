import { useEffect, useState } from "react";
import { fetchActionQueue } from "../lib/api";
import type { ActionQueue as Q } from "../lib/types";

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
        <section className="card">
          <h2>Roles to apply <span className="count">{q.roles_to_apply.length}</span></h2>
          <ul className="clean">
            {q.roles_to_apply.map((r) => (
              <li key={r.id}>
                <strong>{r.title}</strong> @ {r.organization_name}
                {r.closing_soon && <span className="pill pill-warn">closing soon</span>}
                {r.url && <a href={r.url} target="_blank" rel="noreferrer"> ↗</a>}
              </li>
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
