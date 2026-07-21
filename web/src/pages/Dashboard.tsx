import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  fetchApplications, fetchActionQueue, fetchFunnelMetrics,
  fetchRolesAnalytics, runCareerJudge, runGrowthJudge,
} from "../lib/api";
import type { Application, ActionQueue, FunnelMetrics, RoleAnalytics, ApplicationStatus } from "../lib/types";
import { useBatchRunner } from "../lib/useBatchRunner";
import FitScatter from "../components/FitScatter";
import ScheduleInterviewForm from "../components/ScheduleInterviewForm";

// The forward steps that have a "next" stage — the ones with a pass-through rate
// and an in-stage dwell. 'accepted' is the terminal success, so it's omitted.
const STAGE_STEPS = ["applied", "screening", "interviewing", "offer"] as const;

// Every status, in funnel order, with the terminal-negative outcomes
// (rejected / withdrawn / closed) last — the order the By-status bars render in.
const STATUS_DISPLAY_ORDER: ApplicationStatus[] = [
  "draft", "applied", "screening", "interviewing", "offer",
  "accepted", "rejected", "withdrawn", "closed",
];

export default function Dashboard() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [funnel, setFunnel] = useState<FunnelMetrics | null>(null);
  const [roles, setRoles] = useState<RoleAnalytics[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ApplicationStatus | null>(null);
  const [addingInterview, setAddingInterview] = useState(false);
  const [pickedAppId, setPickedAppId] = useState("");
  const batch = useBatchRunner();

  function load() {
    setRefreshing(true);
    setError(null);
    Promise.all([fetchApplications(), fetchActionQueue(), fetchFunnelMetrics(), fetchRolesAnalytics()])
      .then(([a, q, f, r]) => { setApps(a); setQueue(q); setFunnel(f); setRoles(r); })
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

  // The fit map answers "what should I apply to next", so it only plots roles I
  // haven't applied to yet (application_status null) — applied / rejected /
  // withdrawn / closed drop off. The backfill judges this same open set.
  const openRoles = (roles ?? []).filter((r) => r.application_status == null);

  // ── insights backfill: career is per-posting, growth per-company (one judge
  //    call updates every posting at that org) — same sweep the old Insights page ran.
  const careerTodo = openRoles.filter((r) => !r.has_career);
  const growthOrgs = new Map<string, RoleAnalytics>();
  for (const r of openRoles) {
    if (!r.has_growth && !growthOrgs.has(r.organization_id)) growthOrgs.set(r.organization_id, r);
  }
  const growthTodo = [...growthOrgs.values()];
  const todo = careerTodo.length + growthTodo.length;

  async function backfill() {
    setError(null);
    await batch.run([
      ...careerTodo.map((r) => () => runCareerJudge(r.posting_id)),
      ...growthTodo.map((r) => () => runGrowthJudge(r.posting_id)),
    ]);
    load();
  }

  if (error) return <p className="error">{error}</p>;

  const counts: Record<string, number> = {};
  for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const activeApps = apps.filter((a) => !["rejected", "withdrawn", "accepted", "closed"].includes(a.status));
  const active = activeApps.length;
  // bars scale to the biggest bucket so the distribution reads as a chart
  const maxCount = Math.max(1, ...STATUS_DISPLAY_ORDER.map((s) => counts[s] ?? 0));
  const selectedApps = selected ? apps.filter((a) => a.status === selected) : [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="page-head-actions">
          {batch.running ? (
            <span className="muted small">
              Judging {batch.done}/{batch.total}…{batch.errors > 0 && <span className="error"> · {batch.errors} failed</span>}
            </span>
          ) : (
            <button
              className="ghost"
              disabled={todo === 0}
              onClick={backfill}
              title="Run the career-move and company-growth judges for every role that hasn't been judged"
            >
              {todo === 0 ? "All roles judged" : `Judge career + growth · ${careerTodo.length} roles, ${growthTodo.length} cos.`}
            </button>
          )}
          <button className="ghost" disabled={refreshing} onClick={load}>
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* Top-line metrics */}
      <div className="stat-row">
        <div className="card stat"><div className="stat-num">{apps.length}</div><div className="muted">applications</div></div>
        <div className="card stat"><div className="stat-num">{active}</div><div className="muted">active</div></div>
        <div className="card stat"><div className="stat-num">{queue?.roles_to_apply.length ?? "–"}</div><div className="muted">to apply</div></div>
        <div
          className="card stat clickable"
          onClick={() => setAddingInterview((cur) => !cur)}
          title="Add an interview"
        >
          <div className="stat-num">{queue?.upcoming_interviews.length ?? "–"}</div>
          <div className="muted">interviews soon</div>
        </div>
      </div>

      {addingInterview && (
        <section className="card">
          <div className="section-head">
            <h2>Add interview</h2>
            <button className="ghost sm" onClick={() => { setAddingInterview(false); setPickedAppId(""); }}>Close</button>
          </div>
          <label className="muted small">
            Application
            <select value={pickedAppId} onChange={(e) => setPickedAppId(e.target.value)}>
              <option value="">Choose a role…</option>
              {activeApps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.job_postings?.title ?? "Untitled role"} @ {a.job_postings?.organizations?.name ?? ""}
                </option>
              ))}
            </select>
          </label>
          {pickedAppId && (
            <ScheduleInterviewForm
              applicationId={pickedAppId}
              startOpen
              onCancel={() => setPickedAppId("")}
              onScheduled={() => { load(); setAddingInterview(false); setPickedAppId(""); }}
            />
          )}
        </section>
      )}

      <div className="cols">
        {/* By status — every category in funnel order, click one to list its apps */}
        <section className="card">
          <h2>By status</h2>
          {apps.length === 0 ? <p className="muted">No applications yet.</p> : (
            <>
              <p className="muted small">Click a status to see those applications.</p>
              {STATUS_DISPLAY_ORDER.map((s) => {
                const n = counts[s] ?? 0;
                return (
                  <div
                    key={s}
                    className={`bar-row${n > 0 ? " clickable" : ""}${selected === s ? " active" : ""}`}
                    onClick={n > 0 ? () => setSelected((cur) => (cur === s ? null : s)) : undefined}
                  >
                    <span className={`pill pill-${s}`}>{s}</span>
                    <div className="bar"><div className="bar-fill" style={{ width: `${(n / maxCount) * 100}%` }} /></div>
                    <span className="bar-num">{n}</span>
                  </div>
                );
              })}
            </>
          )}
        </section>

        {/* Per-stage pass-through + dwell (pass_through_rate.yaml + days_in_stage.yaml) */}
        <section className="card stage-metrics">
          <h2>Stage funnel</h2>
          {!funnel ? <p className="muted">Loading…</p> : (
            <table className="stage-table">
              <thead>
                <tr>
                  <th>Stage</th><th className="num">Total</th>
                  <th className="num">Pass-through</th><th className="num">Pending</th>
                  <th className="num">Median days</th>
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
      </div>

      {/* Drill-down: the applications in the clicked status */}
      {selected && (
        <section className="card span-2">
          <div className="section-head">
            <h2><span className={`pill pill-${selected}`}>{selected}</span> applications <span className="count">{selectedApps.length}</span></h2>
            <button className="ghost sm" onClick={() => setSelected(null)}>Close</button>
          </div>
          <ul className="clean status-apps">
            {selectedApps.map((a) => (
              <li key={a.id} className="prospect">
                <Link to={`/role/${a.id}`}>{a.job_postings?.title ?? "Untitled role"}</Link>
                <span className="muted">{a.job_postings?.organizations?.name ?? ""}</span>
              </li>
            ))}
            {selectedApps.length === 0 && <li className="muted">None.</li>}
          </ul>
        </section>
      )}

      {/* Next up — upcoming interviews shortcut */}
      <section className="card span-2">
        <h2>Next up</h2>
        {!queue && <p className="muted">Loading…</p>}
        {queue && queue.upcoming_interviews.length === 0 && <p className="muted">No interviews scheduled.</p>}
        <ul className="clean">
          {queue?.upcoming_interviews.map((i) => (
            <li key={i.interview_id}>
              <strong>{i.title}</strong> @ {i.organization_name}
              <span className="muted"> — {i.interview_type} · {new Date(i.scheduled_at).toLocaleString()}</span>
              {" · "}<Link to={`/interview-prep/${i.interview_id}`}>Prep →</Link>
            </li>
          ))}
        </ul>
        <p><Link to="/queue">See the full action queue →</Link></p>
      </section>

      {/* The insights "2x2": fit (x) vs career-move + company-growth (y), the
          top-right quadrant being the sweet spot. Backfill judges from the head. */}
      <section className="card span-2">
        <h2>Fit map</h2>
        <p className="muted small">
          Each role placed by <strong>resume fit</strong> (x) against its{" "}
          <strong>career move + company growth</strong> (y); bubble size is comp, the
          label is location. Top-right is the sweet spot. Faded roles aren't fully
          judged yet — run “Judge career + growth” above to place them for real.
          Only roles you haven’t applied to yet are shown.
        </p>
        {roles == null ? <p className="muted">Loading…</p> : <FitScatter roles={openRoles} />}
      </section>
    </div>
  );
}
