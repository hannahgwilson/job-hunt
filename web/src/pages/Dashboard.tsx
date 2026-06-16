import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { fetchApplications, fetchActionQueue, fetchFunnelMetrics } from "../lib/api";
import type { Application, ActionQueue, FunnelMetrics } from "../lib/types";
import FunnelChart from "../components/FunnelChart";

export default function Dashboard() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [funnel, setFunnel] = useState<FunnelMetrics | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  function load() {
    setRefreshing(true);
    // Load each source independently. Previously a single failing RPC rejected
    // the whole Promise.all and blanked the page — including applications that
    // had loaded fine. Now a partial failure shows what it can plus the error.
    const errs: string[] = [];
    Promise.allSettled([fetchApplications(), fetchActionQueue(), fetchFunnelMetrics()])
      .then(([a, q, f]) => {
        if (a.status === "fulfilled") setApps(a.value);
        else errs.push(`Applications: ${a.reason?.message ?? a.reason}`);
        if (q.status === "fulfilled") setQueue(q.value);
        else errs.push(`Action queue: ${q.reason?.message ?? q.reason}`);
        if (f.status === "fulfilled") setFunnel(f.value);
        else errs.push(`Funnel: ${f.reason?.message ?? f.reason}`);
        setErrors(errs);
      })
      .finally(() => { setRefreshing(false); setLoaded(true); });
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
    load();
    // Live updates: refetch when anything the dashboard shows changes.
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

  const counts: Record<string, number> = {};
  for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const active = apps.filter((a) => !["rejected", "withdrawn", "accepted"].includes(a.status)).length;

  // Logged in, nothing failed, but *nothing at all* came back — no applications,
  // no tracked roles, no interviews: almost always an RLS user_id mismatch (data
  // written under a different id than this login). Having roles but no
  // applications is a normal "haven't applied yet" state, not a mismatch.
  const hasAnyData =
    apps.length > 0 ||
    (queue != null &&
      queue.roles_to_apply.length + queue.upcoming_interviews.length + queue.role_followups.length > 0);
  const emptyButOk = loaded && errors.length === 0 && !hasAnyData;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <button className="ghost" disabled={refreshing} onClick={load}>
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="card banner-error">
          <strong>Some data didn't load.</strong>
          <ul className="clean">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {emptyButOk && (
        <div className="card banner-warn">
          <strong>No applications found for this login.</strong>
          <p className="muted small">
            If you have data in the database, it was likely written under a
            different <code>user_id</code> than this account. Row-Level Security
            only returns rows where <code>user_id = auth.uid()</code>. Set your
            MCP's <code>DEFAULT_USER_ID</code> to the id below, or backfill
            existing rows to it.
          </p>
          {userId && <p className="small">This login's id: <code>{userId}</code></p>}
        </div>
      )}

      <div className="stat-row">
        <div className="card stat"><div className="stat-num">{apps.length}</div><div className="muted">applications</div></div>
        <div className="card stat"><div className="stat-num">{active}</div><div className="muted">active</div></div>
        <div className="card stat"><div className="stat-num">{queue?.roles_to_apply.length ?? "–"}</div><div className="muted">to apply</div></div>
        <div className="card stat"><div className="stat-num">{queue?.upcoming_interviews.length ?? "–"}</div><div className="muted">interviews soon</div></div>
      </div>

      {queue && queue.roles_to_apply.length > 0 && (
        <section className="card">
          <h2>Roles to apply <span className="count">{queue.roles_to_apply.length}</span></h2>
          <p className="muted small">Tracked roles you haven't applied to yet. Work them on the <Link to="/pipeline">Pipeline</Link> tab.</p>
          <ul className="clean">
            {queue.roles_to_apply.map((r) => (
              <li key={r.id} className="prospect">
                <span>
                  <strong>{r.title}</strong> @ {r.organization_name}
                  {r.remote_policy && <span className="muted"> · {r.remote_policy}</span>}
                  {r.closing_soon && <span className="pill pill-warn">closing soon</span>}
                </span>
                {r.url && <a href={r.url} target="_blank" rel="noreferrer">posting ↗</a>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Conversion funnel</h2>
        {!funnel && <p className="muted">Loading…</p>}
        {funnel && funnel.sample_size === 0 && (
          <p className="muted">
            No applications in the funnel yet
            {queue && queue.roles_to_apply.length > 0 && <> — your {queue.roles_to_apply.length} tracked role{queue.roles_to_apply.length === 1 ? "" : "s"} are on the <Link to="/pipeline">Pipeline</Link> tab</>}.
          </p>
        )}
        {funnel && funnel.sample_size > 0 && (
          <>
            <p className="muted small">Sample size: {funnel.sample_size} application{funnel.sample_size === 1 ? "" : "s"}.</p>
            <FunnelChart m={funnel} />
          </>
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
