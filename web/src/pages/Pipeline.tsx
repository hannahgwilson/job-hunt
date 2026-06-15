import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { advanceApplication, fetchApplications } from "../lib/api";
import { PIPELINE_COLUMNS, type Application } from "../lib/types";
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
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

  function load() {
    fetchApplications().then(setApps).catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
    // Realtime: refresh when any application row changes.
    const channel = supabase
      .channel("applications-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "applications" }, load)
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

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Pipeline</h1>
        <button onClick={() => setShowAdd(true)}>+ Add a role</button>
      </div>

      {showAdd && <AddRole onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); load(); }} />}

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
    </div>
  );
}
