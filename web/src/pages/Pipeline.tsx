import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { advanceApplication, fetchApplications, fetchActionQueue, fetchFitCoverage, submitApplication } from "../lib/api";
import { PIPELINE_COLUMNS, type Application, type ActionQueue, type FitCoveragePosting } from "../lib/types";
import { useBatchJudge } from "../lib/useBatchJudge";
import AddRole from "./AddRole";
import RolesToApplyTable from "../components/RolesToApplyTable";

const NEXT: Record<string, string | null> = {
  applied: "screening",
  screening: "interviewing",
  interviewing: "offer",
  offer: "accepted",
  accepted: null,
};

export default function Pipeline() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [coverage, setCoverage] = useState<FitCoveragePosting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const highlightId = params.get("role"); // set by the Insights scatter click-through
  const batch = useBatchJudge();

  function load() {
    fetchApplications().then(setApps).catch((e) => setError(e.message));
    fetchActionQueue().then(setQueue).catch((e) => setError(e.message));
    fetchFitCoverage().then(setCoverage).catch((e) => setError(e.message));
  }

  // Backfill: postings nobody has judged yet (skips the ones done by hand).
  const unjudged = coverage.filter((p) => p.judged_resume_ids.length === 0);

  async function backfill() {
    await batch.run(unjudged.map((p) => ({ jobPostingId: p.id })));
    load();
  }

  useEffect(() => {
    load();
    // Realtime: refresh when applications OR postings change (new prospects
    // appear in the to-apply table; applying moves a role into the kanban).
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

  async function apply(postingId: string) {
    setApplyingId(postingId);
    try {
      await submitApplication(postingId);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyingId(null);
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

      {/* Top of funnel: force-ranked roles to apply to (sortable). */}
      <section className="card span-2">
        <div className="section-head">
          <h2>
            Roles to apply <span className="count">{queue?.roles_to_apply.length ?? 0}</span>
          </h2>
          <div className="section-head-actions">
            {batch.running ? (
              <span className="muted small">Judging {batch.done}/{batch.total}…</span>
            ) : (
              <button
                className="ghost sm"
                disabled={unjudged.length === 0}
                onClick={backfill}
                title="Score every un-judged role against your resumes"
              >
                {unjudged.length === 0 ? "All roles judged" : `Judge ${unjudged.length} un-judged`}
              </button>
            )}
            <span className="muted small">ranked by priority — click a header to re-sort</span>
          </div>
        </div>
        {!queue ? <p className="muted">Loading…</p> : (
          <RolesToApplyTable roles={queue.roles_to_apply} onApply={apply} applyingId={applyingId} highlightId={highlightId} />
        )}
      </section>

      {/* In-flight applications, by stage. */}
      <h2 className="board-title">By stage</h2>
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
