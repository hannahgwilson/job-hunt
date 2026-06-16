import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { advanceApplication, fetchApplications, fetchActionQueue, fetchPostings, submitApplication } from "../lib/api";
import { PIPELINE_COLUMNS, type Application, type ActionQueue, type PostingRow } from "../lib/types";
import RolesTable from "../components/RolesTable";
import AddRole from "./AddRole";

const NEXT: Record<string, string | null> = {
  applied: "screening",
  screening: "interviewing",
  interviewing: "offer",
  offer: "accepted",
  accepted: null,
};

export default function Pipeline() {
  const [apps, setApps] = useState<Application[]>([]);
  const [postings, setPostings] = useState<PostingRow[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const navigate = useNavigate();

  function load() {
    // Independent so one failure still renders the rest.
    fetchApplications().then(setApps).catch((e) => setError(e.message));
    fetchPostings().then(setPostings).catch((e) => setError(e.message));
    fetchActionQueue().then(setQueue).catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
    // Realtime: refresh when applications or postings change.
    const channel = supabase
      .channel("pipeline-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "applications" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_postings" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  async function advance(app: Application) {
    const next = NEXT[app.status];
    if (!next) return;
    try {
      await advanceApplication(app.id, next);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function markApplied(postingId: string) {
    setApplying(postingId);
    setError(null);
    try {
      await submitApplication(postingId);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(null);
    }
  }

  const prospects = queue?.roles_to_apply ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Pipeline</h1>
        <button onClick={() => setShowAdd(true)}>+ Add a role</button>
      </div>

      {error && <p className="error">{error}</p>}
      {showAdd && <AddRole onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); load(); }} />}

      {/* Top of funnel — tracked roles with no live application yet. */}
      <section className="tof">
        <div className="tof-head">
          <h2>To apply <span className="count">{prospects.length}</span></h2>
          <span className="muted small">Tracked roles not yet in the funnel.</span>
        </div>
        {prospects.length === 0 ? (
          <p className="muted small">Nothing waiting — every tracked role has an application.</p>
        ) : (
          <div className="tof-cards">
            {prospects.map((p) => (
              <div key={p.id} className={`card tof-card ${p.closing_soon ? "closing" : ""}`}>
                <div className="tof-title">{p.title}</div>
                <div className="muted small">{p.organization_name}</div>
                <div className="tof-meta muted small">
                  {p.remote_policy && <span>{p.remote_policy}</span>}
                  {p.location && <span> · {p.location}</span>}
                </div>
                {p.closing_soon && <span className="pill pill-warn">closing soon</span>}
                <div className="tof-foot">
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer">posting ↗</a>}
                  <button className="ghost sm" disabled={applying === p.id} onClick={() => markApplied(p.id)}>
                    {applying === p.id ? "…" : "Mark applied"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="kanban">
        {PIPELINE_COLUMNS.map((col) => {
          const inCol = apps.filter((a) => a.status === col);
          return (
            <div key={col} className="kanban-col">
              <div className="kanban-head"><span className={`pill pill-${col}`}>{col}</span><span className="muted">{inCol.length}</span></div>
              {inCol.map((a) => (
                <div key={a.id} className="kanban-card" onClick={() => navigate(`/role/${a.id}`)}>
                  <div className="kc-title">{a.job_postings?.title ?? "Untitled role"}</div>
                  <div className="muted">{a.job_postings?.organizations?.name}</div>
                  <div className="kc-foot">
                    {a.job_postings?.url && (
                      <a href={a.job_postings.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>posting ↗</a>
                    )}
                    {NEXT[a.status] && (
                      <button className="ghost sm" onClick={(e) => { e.stopPropagation(); advance(a); }}>
                        → {NEXT[a.status]}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {inCol.length === 0 && <div className="muted empty">—</div>}
            </div>
          );
        })}
      </div>

      {/* All roles, sortable. Every tracked posting — applied or not. */}
      <section className="card all-roles">
        <h2>All roles <span className="count">{postings.length}</span></h2>
        <p className="muted small">Every tracked role. Click a column to sort; click a row to open it (or its posting).</p>
        <RolesTable postings={postings} />
      </section>
    </div>
  );
}
