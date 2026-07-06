import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { fetchApplications, fetchActionQueue, fetchClosedRoles, fetchFitCoverage, fetchJobChecklist, fetchRejectedApplications, reopenRole, submitApplication } from "../lib/api";
import { CLOSED_REASON_LABELS, PIPELINE_COLUMNS, type Application, type ActionQueue, type ClosedRole, type FitCoveragePosting, type RejectedApplication } from "../lib/types";
import { useBatchJudge } from "../lib/useBatchJudge";
import AddRole from "./AddRole";
import RolesToApplyTable from "../components/RolesToApplyTable";
import PriorityWeightsPanel from "../components/PriorityWeightsPanel";
import StatusActions from "../components/StatusActions";

export default function Pipeline() {
  const [apps, setApps] = useState<Application[]>([]);
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [coverage, setCoverage] = useState<FitCoveragePosting[]>([]);
  const [checklistPostingIds, setChecklistPostingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [closed, setClosed] = useState<ClosedRole[]>([]);
  const [showRejected, setShowRejected] = useState(false);
  const [rejected, setRejected] = useState<RejectedApplication[]>([]);
  const navigate = useNavigate();
  const batch = useBatchJudge();

  function load() {
    fetchApplications().then(setApps).catch((e) => setError(e.message));
    fetchActionQueue().then(setQueue).catch((e) => setError(e.message));
    fetchFitCoverage().then(setCoverage).catch((e) => setError(e.message));
    fetchClosedRoles().then(setClosed).catch((e) => setError(e.message));
    fetchRejectedApplications().then(setRejected).catch((e) => setError(e.message));
    fetchJobChecklist()
      .then((tasks) => setChecklistPostingIds(new Set(tasks.map((t) => t.job_posting_id).filter((id): id is string => !!id))))
      .catch((e) => setError(e.message));
  }

  async function reopen(postingId: string) {
    try {
      await reopenRole(postingId);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
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
            {!batch.running && batch.errors > 0 && (
              <span className="error small" title={batch.lastError ?? undefined}>
                {batch.errors} judge{batch.errors === 1 ? "" : "s"} failed{batch.lastError ? ` — ${batch.lastError}` : ""}
              </span>
            )}
            <span className="muted small">ranked by priority — click a header to re-sort</span>
          </div>
        </div>
        <PriorityWeightsPanel onSaved={() => fetchActionQueue().then(setQueue).catch((e) => setError(e.message))} />
        {!queue ? <p className="muted">Loading…</p> : (
          <RolesToApplyTable
            roles={queue.roles_to_apply}
            onApply={apply}
            applyingId={applyingId}
            checklistPostingIds={checklistPostingIds}
            onChecklistChanged={load}
          />
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
                    {/* Reject / Withdraw move the card off the board into the
                        "Rejected applications" area below. */}
                    <StatusActions app={a} onChanged={load} onError={setError} compact />
                  </div>
                </div>
              ))}
              {inCol.length === 0 && <div className="muted empty">—</div>}
            </div>
          );
        })}
      </div>

      {/* Closed/filled roles — hidden by default, revealed by the toggle. They're
          kept for history (and the funnel) but stay out of the active search. */}
      {closed.length > 0 && (
        <section className="card span-2 closed-roles">
          <div className="section-head">
            <h2>Closed roles <span className="count">{closed.length}</span></h2>
            <button className="ghost sm" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? "Hide" : "Show closed"}
            </button>
          </div>
          {showClosed && (
            <ul className="closed-list">
              {closed.map((r) => (
                <li key={r.id}>
                  <span className="pill pill-closed">{CLOSED_REASON_LABELS[r.closed_reason ?? "other"]}</span>
                  {r.application_id ? (
                    <Link to={`/role/${r.application_id}`}>{r.title}</Link>
                  ) : (
                    <Link to={`/posting/${r.id}`}>{r.title}</Link>
                  )}
                  <span className="muted"> · {r.organization_name}</span>
                  <button className="ghost sm" onClick={() => reopen(r.id)}>Reopen</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Rejected / withdrawn applications — off the board, kept for the record
          (and the funnel) with the stage they died at, how long they sat there,
          and the fit score, so patterns are visible at a glance. */}
      {rejected.length > 0 && (
        <section className="card span-2 rejected-apps">
          <div className="section-head">
            <h2>Rejected applications <span className="count">{rejected.length}</span></h2>
            <button className="ghost sm" onClick={() => setShowRejected((v) => !v)}>
              {showRejected ? "Hide" : "Show rejected"}
            </button>
          </div>
          {showRejected && (
            <table className="rejected-table">
              <thead>
                <tr>
                  <th>Role</th><th>Outcome</th><th>Stage</th>
                  <th className="num">Days in stage</th><th className="num">Days in pipeline</th>
                  <th className="num">Fit</th><th className="num">Interviews</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((r) => (
                  <tr key={r.application_id} onClick={() => navigate(`/role/${r.application_id}`)}>
                    <td>
                      <span className="rt-title">{r.title}</span>
                      <span className="muted"> · {r.organization_name}</span>
                    </td>
                    <td><span className={`pill pill-${r.status}`}>{r.status}</span></td>
                    <td>{r.stage_rejected_at ? <span className={`pill pill-${r.stage_rejected_at}`}>{r.stage_rejected_at}</span> : <span className="muted">—</span>}</td>
                    <td className="num">{r.days_in_stage ?? "—"}</td>
                    <td className="num">{r.days_in_pipeline ?? "—"}</td>
                    <td className="num">{r.fit_score != null ? `${Math.round(r.fit_score * 100)}%` : "—"}</td>
                    <td className="num">{r.interviews}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
