import { useEffect, useState } from "react";
import { useBatchJudge } from "../lib/useBatchJudge";
import type { FitCoveragePosting } from "../lib/types";

// Score one resume against a chosen subset of roles. Used when a new resume is
// added (unscored roles pre-selected to backfill just this variant), and to
// re-score everything after the judge rubric changes ("Rescore all"). Selection
// helpers (all / unscored / none) make a long role list workable.
export default function ResumeScoringPanel({
  resumeId, resumeLabel, coverage, onDone,
}: {
  resumeId: string;
  resumeLabel: string;
  coverage: FitCoveragePosting[];
  onDone: () => void;
}) {
  const batch = useBatchJudge();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isJudged = (p: FitCoveragePosting) => p.judged_resume_ids.includes(resumeId);
  const unscored = coverage.filter((p) => !isJudged(p));

  // Default selection = roles this resume hasn't been scored against yet.
  useEffect(() => {
    setSelected(new Set(coverage.filter((p) => !p.judged_resume_ids.includes(resumeId)).map((p) => p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, coverage]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const selectAll = () => setSelected(new Set(coverage.map((p) => p.id)));
  const selectUnscored = () => setSelected(new Set(unscored.map((p) => p.id)));
  const clearSel = () => setSelected(new Set());

  async function judge(ids: string[]) {
    if (ids.length === 0) return;
    await batch.run(ids.map((id) => ({ jobPostingId: id, resumeId })));
    onDone();
  }

  if (coverage.length === 0) return <p className="muted small">No roles to score yet.</p>;

  const scoredCount = coverage.length - unscored.length;

  return (
    <details className="scoring-panel">
      <summary>
        Score “{resumeLabel}” against roles
        <span className="muted small"> · {scoredCount}/{coverage.length} scored</span>
        {unscored.length > 0 && <span className="pill pill-warn">{unscored.length} not scored</span>}
      </summary>

      <div className="scoring-actions">
        {batch.running ? (
          <span className="muted small">Judging {batch.done}/{batch.total}…</span>
        ) : (
          <>
            <button className="sm" disabled={selected.size === 0} onClick={() => judge([...selected])}>
              Judge {selected.size} selected
            </button>
            <button
              className="ghost sm"
              onClick={() => judge(coverage.map((p) => p.id))}
              title="Re-run the judge on every role against this resume (use after changing the rubric)"
            >
              ↻ Rescore all {coverage.length}
            </button>
          </>
        )}
        {!batch.running && batch.errors > 0 && (
          <span className="error small" title={batch.lastError ?? undefined}>
            {batch.errors} failed{batch.lastError ? ` — ${batch.lastError}` : ""}
          </span>
        )}
      </div>

      {!batch.running && (
        <div className="scoring-select muted small">
          Select:
          <button className="linklike" onClick={selectAll}>all</button>
          <button className="linklike" onClick={selectUnscored} disabled={unscored.length === 0}>unscored</button>
          <button className="linklike" onClick={clearSel}>none</button>
        </div>
      )}

      <ul className="scoring-list">
        {coverage.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="scoring-role">
                {p.title}
                <span className="muted"> · {p.organization_name}</span>
              </span>
            </label>
            {isJudged(p) && <span className="muted small scoring-scored">✓ scored</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
