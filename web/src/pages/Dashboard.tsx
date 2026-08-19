import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  fetchApplications, fetchActionQueue, fetchFunnelMetrics, fetchStageRoles,
  fetchRolesAnalytics, fetchInterviews, runCareerJudge, runGrowthJudge,
} from "../lib/api";
import { awaitingDebrief, roundLabel } from "../lib/rounds";
import type {
  Application, ActionQueue, FunnelMetrics, StageRoles, RoleAnalytics, ApplicationStatus,
  InterviewListRow,
} from "../lib/types";
import { useBatchRunner } from "../lib/useBatchRunner";
import FitScatter from "../components/FitScatter";
import ScheduleInterviewForm from "../components/ScheduleInterviewForm";

// The forward steps that have a "next" stage — the ones with a pass-through rate
// and an in-stage dwell. 'accepted' is the terminal success, so it's omitted.
const STAGE_STEPS = ["applied", "screening", "interviewing", "offer"] as const;

// The outcomes that take an application off the live board and into Archive.
const TERMINAL_STATUSES: ApplicationStatus[] = ["rejected", "withdrawn", "closed", "accepted"];

export default function Dashboard() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [funnel, setFunnel] = useState<FunnelMetrics | null>(null);
  const [stageRoles, setStageRoles] = useState<StageRoles | null>(null);
  const [roles, setRoles] = useState<RoleAnalytics[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ApplicationStatus | null>(null);
  const [selectedStage, setSelectedStage] = useState<(typeof STAGE_STEPS)[number] | null>(null);
  const [tab, setTab] = useState<"live" | "archive">("live");
  const [addingInterview, setAddingInterview] = useState(false);
  const [pickedAppId, setPickedAppId] = useState("");
  const [interviews, setInterviews] = useState<InterviewListRow[]>([]);
  const batch = useBatchRunner();
  const navigate = useNavigate();

  function load() {
    setRefreshing(true);
    setError(null);
    Promise.all([
      fetchApplications(), fetchActionQueue(), fetchFunnelMetrics(), fetchStageRoles(),
      fetchRolesAnalytics(), fetchInterviews(),
    ])
      .then(([a, q, f, sr, r, iv]) => {
        setApps(a); setQueue(q); setFunnel(f); setStageRoles(sr); setRoles(r); setInterviews(iv);
      })
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
  const selectedApps = selected ? apps.filter((a) => a.status === selected) : [];
  // T3.1 — overdue rounds distort the funnel (they keep counting as pending),
  // so they belong on the top-line strip, not only inside the Interviews tab.
  const overdueDebriefs = awaitingDebrief(interviews);

  // The live search vs everything that's already over. Most of the data is
  // history — 45 of 81 postings closed on the real account — so the two get
  // separate homes instead of the same weight of ink (review, finding 02).
  const archivedApps = apps.filter((a) => TERMINAL_STATUSES.includes(a.status));

  // Pass-through across every decided stage: the single "am I converting?" read.
  const decidedAll = STAGE_STEPS.reduce(
    (acc, st) => {
      const pt = funnel?.pass_through?.[st];
      return pt ? { moved: acc.moved + pt.moved_on, decided: acc.decided + pt.moved_on + pt.terminated_here } : acc;
    },
    { moved: 0, decided: 0 },
  );
  const overallPass = decidedAll.decided > 0 ? Math.round((decidedAll.moved / decidedAll.decided) * 100) : null;

  // The funnel bars scale to the widest stage so the taper is the shape.
  const funnelMax = Math.max(1, ...STAGE_STEPS.map((st) => funnel?.pass_through?.[st]?.total_ever ?? 0));
  const oldestDebrief = [...overdueDebriefs].sort(
    (a, b) => new Date(a.scheduled_at ?? 0).getTime() - new Date(b.scheduled_at ?? 0).getTime(),
  )[0];
  const daysSince = (iso: string | null) =>
    iso ? Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

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

      <div className="dash-tabs">
        <div className="segmented">
          <button className={tab === "live" ? "on" : ""} onClick={() => setTab("live")}>
            Live <span className="seg-count">{active}</span>
          </button>
          <button className={tab === "archive" ? "on" : ""} onClick={() => setTab("archive")}>
            Archive <span className="seg-count">{archivedApps.length}</span>
          </button>
        </div>
      </div>

      {tab === "live" && (
        <>
          {/* One decision, at the top. Only rendered when there is one — an
              empty version of this band would be worse than no band. */}
          {overdueDebriefs.length > 0 && (
            <div className="next-action">
              <span className="next-action-n">{overdueDebriefs.length}</span>
              <div>
                <div className="next-action-t">
                  {overdueDebriefs.length === 1 ? "Round waiting on a debrief" : "Rounds waiting on a debrief"}
                </div>
                <div className="next-action-s">
                  {oldestDebrief && (
                    <>
                      Oldest: {oldestDebrief.organization_name} · {roundLabel(oldestDebrief.interview_type)}
                      {daysSince(oldestDebrief.scheduled_at) != null && ` · ${daysSince(oldestDebrief.scheduled_at)} days ago`}.{" "}
                    </>
                  )}
                  Until they're closed out, the pass rate below is wrong.
                </div>
              </div>
              <span className="spacer" />
              <button onClick={() => navigate("/interviews")}>Close them out</button>
            </div>
          )}

          <div className="tiles">
            <div className="tile">
              <span className="k">Live applications</span>
              <span className="n">{active}</span>
              <span className="d">{counts.interviewing ?? 0} interviewing · {counts.offer ?? 0} offer</span>
            </div>
            <button
              className="tile clickable"
              onClick={() => setSelected((cur) => (cur === "interviewing" ? null : "interviewing"))}
            >
              <span className="k">In loop</span>
              <span className="n">{counts.interviewing ?? 0}</span>
              <span className="d">interviewing now</span>
            </button>
            <button
              className="tile clickable"
              onClick={() => setSelected((cur) => (cur === "offer" ? null : "offer"))}
            >
              <span className="k">Offers</span>
              <span className="n">{counts.offer ?? 0}</span>
              <span className="d">{counts.accepted ?? 0} accepted</span>
            </button>
            <button className="tile clickable" onClick={() => navigate("/pipeline")}>
              <span className="k">Ready to apply</span>
              <span className="n">{queue?.roles_to_apply.length ?? "–"}</span>
              <span className="d">force-ranked</span>
            </button>
            <div className="tile">
              <span className="k">Pass rate</span>
              <span className="n">{overallPass != null ? `${overallPass}%` : "–"}</span>
              <span className="d">{decidedAll.moved}/{decidedAll.decided} decided rounds</span>
            </div>
            <button className="tile clickable" onClick={() => setAddingInterview((cur) => !cur)}>
              <span className="k">Interviews · 14d</span>
              <span className="n">{queue?.upcoming_interviews.length ?? "–"}</span>
              <span className="d">{addingInterview ? "close" : "add one"}</span>
            </button>
          </div>
        </>
      )}

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

      {tab === "live" && (
        <div className="cols">
          {/* Top of funnel: what to apply to next, in priority order. */}
          <section className="panel">
            <div className="panel-head">
              <h2>Apply next</h2>
              <span className="meta">force-ranked · {queue?.roles_to_apply.length ?? 0} open</span>
            </div>
            {!queue && <p className="panel-empty">Loading…</p>}
            {queue && queue.roles_to_apply.length === 0 && (
              <p className="panel-empty">Nothing waiting — every tracked role has an application.</p>
            )}
            {queue?.roles_to_apply.slice(0, 6).map((r, idx) => {
              const score = r.priority?.score ?? 0;
              const comps = r.priority?.components;
              const band = score >= 70 ? "" : score >= 45 ? " mid" : " low";
              const comp = r.salary_min && r.salary_max
                ? `$${Math.round(r.salary_min / 1000)}–${Math.round(r.salary_max / 1000)}k`
                : null;
              const where = [r.location, r.remote_policy].filter(Boolean).join(" · ");
              return (
                <button
                  key={r.id}
                  className={`qrow${idx < 2 ? " hot" : ""}`}
                  onClick={() => navigate(`/posting/${r.id}`)}
                >
                  <span className={`qrow-num${band}`}>{score.toFixed(1)}</span>
                  <span>
                    <span className="qrow-title">{r.title} · {r.organization_name}</span>
                    <br />
                    <span className="qrow-sub">
                      {[comp, where].filter(Boolean).join(" · ")}
                      {r.closing_soon && <span className="soon"> · closing soon</span>}
                    </span>
                  </span>
                  {/* The five priority inputs, at a glance — the same components
                      compute_priority scored, so a low bar is a visible reason. */}
                  <span className="cbars">
                    {comps
                      ? (["experience", "location", "comp", "career", "growth"] as const).map((k) => (
                          <i
                            key={k}
                            className={comps[k] >= 0.6 ? "f" : ""}
                            style={{ height: `${Math.max(4, Math.round(comps[k] * 18))}px` }}
                          />
                        ))
                      : null}
                  </span>
                </button>
              );
            })}
          </section>

          {/* Where the loop dies — pass-through per stage, drawn as a taper. */}
          <section className="panel">
            <div className="panel-head">
              <h2>Where the loop dies</h2>
              <span className="meta">advanced ÷ decided</span>
            </div>
            <div className="panel-body">
              {!funnel ? <p className="muted small">Loading…</p> : (
                <div className="funnel">
                  {STAGE_STEPS.map((st) => {
                    const pt = funnel.pass_through?.[st];
                    const total = pt?.total_ever ?? 0;
                    const rate = pt?.rate;
                    return (
                      <div
                        key={st}
                        className={`frow${total > 0 ? " clickable" : ""}`}
                        onClick={total > 0 ? () => setSelectedStage((cur) => (cur === st ? null : st)) : undefined}
                        title={total > 0 ? `${total} reached ${st} — click for the roles` : undefined}
                      >
                        <span className="flabel">{st}</span>
                        <span className="ftrack">
                          <span className="ffill" style={{ width: `${Math.max(3, (total / funnelMax) * 100)}%` }} />
                        </span>
                        <span className="fn">{total}</span>
                        {rate != null
                          ? <span className={`fpct${rate < 0.75 ? " drop" : ""}`}>{Math.round(rate * 100)}%</span>
                          : <span className="fpct none">—</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="muted small" style={{ marginTop: "0.7rem" }}>
                Bar length is how many applications ever reached that stage; the
                percentage is how many of the <em>decided</em> ones moved on.
                {overdueDebriefs.length > 0 && " Undebriefed rounds sit outside both."}
              </p>
            </div>
          </section>
        </div>
      )}

      {/* Archive — the 21-of-36 that are already over. Same data, deliberately
          quieter: an outcome list you scan, not a board you work. */}
      {tab === "archive" && (
        <section className="panel">
          <div className="panel-head">
            <h2>Closed out</h2>
            <span className="meta">{archivedApps.length} applications</span>
          </div>
          {archivedApps.length === 0 ? (
            <p className="panel-empty">Nothing archived yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Role</th><th>Company</th><th>Outcome</th><th className="num">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {archivedApps
                    .slice()
                    .sort((a, b) => (b.applied_date ?? "").localeCompare(a.applied_date ?? ""))
                    .map((a) => (
                      <tr key={a.id} className="clickable" onClick={() => navigate(`/role/${a.id}`)}>
                        <td className="role-title">{a.job_postings?.title ?? "Untitled role"}</td>
                        <td>{a.job_postings?.organizations?.name ?? "—"}</td>
                        <td><span className={`pill pill-${a.status}`}>{a.status}</span></td>
                        <td className="num">{a.applied_date ?? "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

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

      {/* Drill-down: every role that ever reached the clicked stage (semantic/metrics/stage_roles.yaml) */}
      {selectedStage && (
        <section className="card span-2">
          <div className="section-head">
            <h2>
              <span className={`pill pill-${selectedStage}`}>{selectedStage}</span> roles{" "}
              <span className="count">{stageRoles?.roles?.[selectedStage]?.length ?? 0}</span>
            </h2>
            <button className="ghost sm" onClick={() => setSelectedStage(null)}>Close</button>
          </div>
          <p className="muted small">
            Every role that <em>ever</em> reached this stage — the Status column is where each one is <em>today</em>.
          </p>
          <table className="stage-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Status</th>
                <th className="num">Interviews done</th>
                <th className="num">Interviews pending</th>
                <th>Furthest round</th>
                <th className="num">Days since applied</th>
                <th className="num">Days since screen</th>
              </tr>
            </thead>
            <tbody>
              {(stageRoles?.roles?.[selectedStage] ?? []).map((r) => (
                // Terminal rows are history, not action items — fade them so the
                // still-live entries carry the row's visual weight (T1.5).
                <tr
                  key={r.application_id}
                  className={r.status && ["rejected", "withdrawn", "closed"].includes(r.status) ? "row-terminal" : ""}
                >
                  <td>
                    <Link to={`/role/${r.application_id}`}>{r.title}</Link>
                    <span className="muted"> @ {r.organization_name}</span>
                  </td>
                  <td>{r.status ? <span className={`pill pill-${r.status}`}>{r.status}</span> : <span className="muted">—</span>}</td>
                  <td className="num">{r.interviews_completed}</td>
                  <td className="num">{r.interviews_pending}</td>
                  <td>{r.furthest_round ?? <span className="muted">—</span>}</td>
                  <td className="num">{r.days_since_applied ?? <span className="muted">—</span>}</td>
                  <td className="num">{r.days_since_screen ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
              {(stageRoles?.roles?.[selectedStage] ?? []).length === 0 && (
                <tr><td colSpan={7} className="muted">None.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {tab === "live" && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Next up</h2>
              <Link className="meta" to="/queue">full action queue →</Link>
            </div>
            {!queue && <p className="panel-empty">Loading…</p>}
            {queue && queue.upcoming_interviews.length === 0 && (
              <p className="panel-empty">
                Nothing on the calendar.{" "}
                {queue.roles_to_apply.length > 0
                  ? <>The queue above has {queue.roles_to_apply.length} roles ready to apply to.</>
                  : <>Add a role from the Pipeline to get the queue moving.</>}
              </p>
            )}
            {queue && queue.upcoming_interviews.length > 0 && (
              <div>
                {queue.upcoming_interviews.map((i) => (
                  <div key={i.interview_id} className="qrow">
                    <span className="qrow-num">{new Date(i.scheduled_at).getDate()}</span>
                    <span>
                      <span className="qrow-title">{i.title} · {i.organization_name}</span>
                      <br />
                      <span className="qrow-sub">
                        {roundLabel(i.interview_type)} · {new Date(i.scheduled_at).toLocaleString()}
                      </span>
                    </span>
                    <Link className="small" to={`/interview-prep/${i.interview_id}`}>Prep →</Link>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* The insights "2x2": fit (x) vs career-move + company-growth (y), the
              top-right quadrant being the sweet spot. Backfill judges from the head. */}
          <section className="panel">
            <div className="panel-head">
              <h2>Fit map</h2>
              <span className="meta">{openRoles.length} un-applied roles</span>
            </div>
            <div className="panel-body">
              {roles == null ? <p className="muted small">Loading…</p> : <FitScatter roles={openRoles} />}
              <p className="muted small">
                Resume fit across, career move + company growth up. Top-right is the
                sweet spot; faded roles aren't fully judged yet.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
