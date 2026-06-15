import { useEffect, useState } from "react";
import { fetchFunnelMetrics, fetchActionQueue, submitApplication } from "../lib/api";
import type { FunnelMetrics, ActionQueue } from "../lib/types";

const STAGES = ["applied", "screening", "interviewing", "offer", "accepted"];

export default function Funnel() {
  const [m, setM] = useState<FunnelMetrics | null>(null);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  function load() {
    Promise.all([fetchFunnelMetrics(), fetchActionQueue()])
      .then(([fm, q]) => { setM(fm); setQueue(q); })
      .catch((e) => setError(e.message));
  }

  useEffect(() => { load(); }, []);

  async function markApplied(postingId: string) {
    setApplying(postingId);
    setError(null);
    try {
      await submitApplication(postingId);
      load();              // prospect leaves the list; funnel sample grows
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!m || !queue) return <p className="muted">Loading…</p>;

  const top = m.stage_counts[STAGES[0]] ?? 0;
  const prospects = queue.roles_to_apply;

  return (
    <div className="page">
      <h1>Funnel</h1>

      <section className="card">
        <h2>Prospects — not yet applied <span className="count">{prospects.length}</span></h2>
        <p className="muted small">Tracked roles that haven't entered the funnel. Top of funnel.</p>
        <ul className="clean">
          {prospects.map((p) => (
            <li key={p.id} className="prospect">
              <span>
                <strong>{p.title}</strong> @ {p.organization_name}
                {p.closing_soon && <span className="pill pill-warn">closing soon</span>}
                {p.url && <a href={p.url} target="_blank" rel="noreferrer"> ↗</a>}
              </span>
              <button className="ghost sm" disabled={applying === p.id} onClick={() => markApplied(p.id)}>
                {applying === p.id ? "…" : "Mark applied"}
              </button>
            </li>
          ))}
          {prospects.length === 0 && <li className="muted">No un-applied prospects.</li>}
        </ul>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Conversion</h2>
        <p className="muted small">Sample size: {m.sample_size} application{m.sample_size === 1 ? "" : "s"}.</p>
        <div className="funnel">
          {STAGES.map((stage, i) => {
            const count = m.stage_counts[stage] ?? 0;
            const width = top > 0 ? Math.max((count / top) * 100, 4) : 4;
            const conv = i > 0 ? m.conversion_rates[`${STAGES[i - 1]}_to_${stage}`] : null;
            const med = m.median_days_from_applied[stage];
            return (
              <div key={stage} className="funnel-row">
                <div className="funnel-label">{stage}</div>
                <div className="funnel-bar-wrap">
                  <div className="funnel-bar" style={{ width: `${width}%` }}>{count}</div>
                </div>
                <div className="funnel-meta muted">
                  {conv != null && <span>{Math.round(conv * 100)}% from {STAGES[i - 1]}</span>}
                  {med != null && <span> · median {med}d from applied</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
