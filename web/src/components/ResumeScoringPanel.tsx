import { useEffect, useState } from "react";
import { useBatchJudge } from "../lib/useBatchJudge";
import type { FitCoveragePosting } from "../lib/types";

// Score one resume against a chosen subset of roles. Used when a new resume is
// added: roles not yet judged against it are pre-selected so you can backfill
// just this variant without re-spending on the others.
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

  // Default selection = roles this resume hasn't been scored against yet.
  useEffect(() => {
    setSelected(new Set(coverage.filter((p) => !isJudged(p)).map((p) => p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, coverage]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function judge() {
    await batch.run([...selected].map((id) => ({ jobPostingId: id, resumeId })));
    onDone();
  }

  if (coverage.length === 0) return <p className="muted small">No roles to score yet.</p>;

  const unjudgedCount = coverage.filter((p) => !isJudged(p)).length;

  return (
    <details className="scoring-panel">
      <summary>
        Score “{resumeLabel}” against roles
        {unjudgedCount > 0 && <span className="pill pill-warn">{unjudgedCount} not scored</span>}
      </summary>

      <div className="scoring-actions">
        {batch.running ? (
          <span className="muted small">Judging {batch.done}/{batch.total}…</span>
        ) : (
          <button className="sm" disabled={selected.size === 0} onClick={judge}>
            Judge {selected.size} selected
          </button>
        )}
        {!batch.running && batch.errors > 0 && (
          <span className="error small" title={batch.lastError ?? undefined}>
            {batch.errors} failed{batch.lastError ? ` — ${batch.lastError}` : ""}
          </span>
        )}
      </div>

      <ul className="scoring-list">
        {coverage.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.title} <span className="muted small">· {p.organization_name}</span></span>
            </label>
            {isJudged(p) && <span className="muted small">✓ scored</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
