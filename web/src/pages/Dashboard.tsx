import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { fetchApplications, fetchActionQueue, fetchFunnelMetrics } from "../lib/api";
import type { Application, ActionQueue, FunnelMetrics } from "../lib/types";

// The forward steps that have a "next" stage — the ones with a pass-through rate
// and an in-stage dwell. 'accepted' is the terminal success, so it's omitted.
const STAGE_STEPS = ["applied", "screening", "interviewing", "offer"] as const;

export default function Dashboard() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [funnel, setFunnel] = useState<FunnelMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function load() {
    setRefreshing(true);
    setError(null);
    Promise.all([fetchApplications(), fetchActionQueue(), fetchFunnelMetrics()])
      .then(([a, q, f]) => { setApps(a); setQueue(q); setFunnel(f); })
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  }

  useEffect(() => {
    load();
    // Live updates: refetch when anything the dashboard shows changes —
    // postings (new prospects), applications (status), interviews (upcoming).
    // Requires these tables to be in the Supabase realtime publication
    // (Database → Replication); the Refresh button works regardless.
    const channel = supabase
      .channel("dashboard-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_postings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "applications" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "interviews" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  if (error) return <p className="error">{error}</p>;

  const counts: Record<string, number> = {};
  for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const active = apps.filter((a) => !["rejected", "withdrawn", "accepted"].includes(a.status)).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <button className="ghost" disabled={refreshing} onClick={load}>
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <div className="stat-row">
        <div className="card stat"><div className="stat-num">{apps.length}</div><div className="muted">applications</div></div>
        <div className="card stat"><div className="stat-num">{active}</div><div className="muted">active</div></div>
        <div className="card stat"><div className="stat-num">{queue?.roles_to_apply.length ?? "–"}</div><div className="muted">to apply</div></div>
        <div className="card stat"><div className="stat-num">{queue?.upcoming_interviews.length ?? "–"}</div><div className="muted">interviews soon</div></div>
      </div>

      {/* Per-stage pass-through + dwell. Pass-through = advanced / decided
          (still-waiting apps kept aside as Pending); see semantic/metrics/
          pass_through_rate.yaml + days_in_stage.yaml. */}
      <section className="card span-2 stage-metrics">
        <h2>Stage funnel</h2>
        {!funnel ? <p className="muted">Loading…</p> : (
          <table className="stage-table">
            <thead>
              <tr>
                <th>Stage</th><th className="num">Total</th>
                <th className="num">Pass-through</th><th className="num">Pending</th>
                <th className="num">Median days in stage</th>
              </tr>
            </thead>
            <tbody>
              {STAGE_STEPS.map((s) => {
                const pt = funnel.pass_through?.[s];
                const dwell = funnel.median_days_in_stage?.[s];
                const decided = pt ? pt.moved_on + pt.terminated_here : 0;
                return (
                  <tr key={s}>
                    <td><span className={`pill pill-${s}`}>{s}</span></td>
                    <td className="num">{pt?.total_ever ?? 0}</td>
                    <td className="num">
                      {pt && pt.rate != null
                        ? <>{Math.round(pt.rate * 100)}% <span className="muted">({pt.moved_on}/{decided})</span></>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num">{pt?.pending ?? 0}</td>
                    <td className="num">{dwell != null ? dwell : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="cols">
        <section className="card">
          <h2>By status</h2>
          {Object.keys(counts).length === 0 && <p className="muted">No applications yet.</p>}
          {Object.entries(counts).map(([s, n]) => (
            <div key={s} className="bar-row">
              <span className={`pill pill-${s}`}>{s}</span>
              <div className="bar"><div className="bar-fill" style={{ width: `${(n / apps.length) * 100}%` }} /></div>
              <span className="bar-num">{n}</span>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Next up</h2>
          {!queue && <p className="muted">Loading…</p>}
          {queue && queue.upcoming_interviews.length === 0 && <p className="muted">No interviews scheduled.</p>}
          <ul className="clean">
            {queue?.upcoming_interviews.map((i) => (
              <li key={i.interview_id}>
                <strong>{i.title}</strong> @ {i.organization_name}
                <span className="muted"> — {i.interview_type} · {new Date(i.scheduled_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p><Link to="/queue">See the full action queue →</Link></p>
        </section>
      </div>
    </div>
  );
}
