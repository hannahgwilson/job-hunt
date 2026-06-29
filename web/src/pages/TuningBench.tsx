import { useEffect, useMemo, useState } from "react";
import {
  listResumes, fetchFitCoverage, runJudge, getRoleFit, saveFitEval, fetchFitEvals,
} from "../lib/api";
import type {
  Resume, FitCoveragePosting, RoleFitResponse, ResumeFitEntry, FitRating,
} from "../lib/types";
import { FitDetails, pct, alignClass } from "../components/RoleFitPanel";

/**
 * Tuning Bench — run the judge against your résumés × a few JDs you pick, then
 * rate each analysis (good/bad + "best for this JD" + notes). The labels persist
 * to fit_eval and the "Copy tuning data" export hands back what the judge said
 * next to your verdict — the intel for tuning the judge-fit prompt.
 *
 * Each (posting × selected résumé) is judged with runJudge(postingId, resumeId),
 * which returns the fresh get_role_fit payload (incl. the per-requirement
 * adjacency table and any prior eval), so we render straight from it.
 */

function Picker<T>({
  title, items, id, label, selected, toggle, hint,
}: {
  title: string;
  items: T[];
  id: (t: T) => string;
  label: (t: T) => React.ReactNode;
  selected: Set<string>;
  toggle: (id: string) => void;
  hint?: string;
}) {
  return (
    <section className="card bench-picker">
      <div className="section-head">
        <h3>{title}</h3>
        <span className="muted small">{selected.size} selected</span>
      </div>
      {hint && <p className="muted small">{hint}</p>}
      <ul className="bench-pick-list">
        {items.map((t) => {
          const key = id(t);
          return (
            <li key={key}>
              <label className="bench-check">
                <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                <span>{label(t)}</span>
              </label>
            </li>
          );
        })}
        {items.length === 0 && <li className="muted small">none yet</li>}
      </ul>
    </section>
  );
}

// One analysis card: the alignment + adjacency table + the eval controls.
function AnalysisCard({
  entry, postingId, onSaved,
}: {
  entry: ResumeFitEntry;
  postingId: string;
  onSaved: (resumeId: string, patch: Partial<NonNullable<ResumeFitEntry["eval"]>>) => void;
}) {
  const fit = entry.fit;
  const ev = entry.eval ?? null;
  const [notes, setNotes] = useState(ev?.notes ?? "");
  const [savingNote, setSavingNote] = useState(false);

  // Keep the textarea in sync if the row reloads with a different value.
  useEffect(() => { setNotes(ev?.notes ?? ""); }, [ev?.notes]);

  async function rate(next: FitRating) {
    const clearing = ev?.rating === next;
    await saveFitEval({ jobPostingId: postingId, resumeId: entry.resume_id,
      rating: clearing ? undefined : next, clearRating: clearing });
    onSaved(entry.resume_id, { rating: clearing ? null : next });
  }
  async function toggleBest() {
    const next = !ev?.is_best;
    await saveFitEval({ jobPostingId: postingId, resumeId: entry.resume_id, isBest: next });
    onSaved(entry.resume_id, { is_best: next });
  }
  async function saveNotes() {
    setSavingNote(true);
    try {
      await saveFitEval({ jobPostingId: postingId, resumeId: entry.resume_id, notes });
      onSaved(entry.resume_id, { notes });
    } finally { setSavingNote(false); }
  }

  return (
    <section className={`card fit-card bench-analysis${ev?.is_best ? " is-best" : ""}`}>
      <div className="fit-card-head">
        <div>
          <strong>{entry.label}</strong>
          {entry.variant && <span className="pill">{entry.variant}</span>}
          {ev?.is_best && <span className="pill pill-accepted">★ best for this JD</span>}
        </div>
        <span className={`score-badge ${alignClass(fit?.alignment ?? null)}`}>{pct(fit?.alignment ?? null)}</span>
      </div>

      {!fit ? (
        <p className="muted small">No analysis yet.</p>
      ) : (
        <>
          <FitDetails fit={fit} />

          <div className="bench-eval">
            <div className="bench-eval-row">
              <span className="muted small">Is this analysis right?</span>
              <button className={`sm ${ev?.rating === "good" ? "rate-on-good" : "ghost"}`} onClick={() => rate("good")}>👍 good</button>
              <button className={`sm ${ev?.rating === "bad" ? "rate-on-bad" : "ghost"}`} onClick={() => rate("bad")}>👎 off</button>
              <button className={`sm ${ev?.is_best ? "rate-on-best" : "ghost"}`} onClick={toggleBest}>★ best</button>
            </div>
            <textarea
              className="bench-notes"
              placeholder="What did the judge get wrong / what should it weigh differently? (tuning intel)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => { if (notes !== (ev?.notes ?? "")) saveNotes(); }}
            />
            {savingNote && <span className="muted small">saving…</span>}
          </div>
        </>
      )}
    </section>
  );
}

export default function TuningBench() {
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [postings, setPostings] = useState<FitCoveragePosting[]>([]);
  const [pickResumes, setPickResumes] = useState<Set<string>>(new Set());
  const [pickPostings, setPickPostings] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, RoleFitResponse>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listResumes(), fetchFitCoverage()])
      .then(([rs, ps]) => { setResumes(rs); setPostings(ps); })
      .catch((e) => setError(e.message));
  }, []);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) =>
    set((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const totalRuns = pickResumes.size * pickPostings.size;

  async function runAll() {
    if (totalRuns === 0) return;
    setRunning(true); setError(null); setExported(null);
    const resumeIds = [...pickResumes];
    const postingIds = [...pickPostings];

    // Every (posting × résumé) pair, run through a small concurrency pool — the
    // judge calls are independent, so serializing them was the main wall-clock
    // cost. When a posting's last résumé lands we refetch its consolidated fit
    // ONCE (race-free) so all variants render together.
    const queue = postingIds.flatMap((postingId) =>
      resumeIds.map((resumeId) => ({ postingId, resumeId })));
    const remaining = new Map(postingIds.map((id) => [id, resumeIds.length]));
    let done = 0;
    const CONCURRENCY = 5;

    async function worker() {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        await runJudge(job.postingId, job.resumeId);
        setProgress(`Judging ${++done}/${totalRuns}…`);
        const left = (remaining.get(job.postingId) ?? 1) - 1;
        remaining.set(job.postingId, left);
        if (left === 0) {
          const fresh = await getRoleFit(job.postingId);
          setResults((prev) => ({ ...prev, [job.postingId]: fresh }));
        }
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      setProgress("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Patch one analysis's eval in place after a rating save (no full refetch).
  function patchEval(postingId: string, resumeId: string, patch: Partial<NonNullable<ResumeFitEntry["eval"]>>) {
    setResults((prev) => {
      const r = prev[postingId];
      if (!r) return prev;
      return {
        ...prev,
        [postingId]: {
          ...r,
          resumes: r.resumes.map((e) =>
            e.resume_id === resumeId
              ? { ...e, eval: { rating: null, is_best: false, notes: null, updated_at: null, ...(e.eval ?? {}), ...patch } }
              : e),
        },
      };
    });
  }

  async function copyExport() {
    try {
      const rows = await fetchFitEvals();
      const json = JSON.stringify(rows, null, 2);
      setExported(json);
      try { await navigator.clipboard.writeText(json); } catch { /* clipboard may be blocked; the <pre> still shows it */ }
    } catch (e) { setError((e as Error).message); }
  }

  const orderedPostings = useMemo(
    () => [...pickPostings].map((id) => results[id]).filter(Boolean) as RoleFitResponse[],
    [pickPostings, results],
  );

  return (
    <div className="bench">
      <div className="section-head">
        <h1>Tuning Bench</h1>
        <div className="section-head-actions">
          <button onClick={runAll} disabled={running || totalRuns === 0}>
            {running ? (progress || "Running…") : `Run ${totalRuns || ""} analysis${totalRuns === 1 ? "" : "es"}`}
          </button>
          <button className="ghost" onClick={copyExport} disabled={running}>Copy tuning data</button>
        </div>
      </div>
      <p className="muted">
        Pick résumés and a few JDs, run the judge, then rate each analysis. Ratings feed{" "}
        <code>fit_eval</code>; “Copy tuning data” exports your verdicts next to what the judge said.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="bench-pickers">
        <Picker
          title="Résumés"
          items={resumes}
          id={(r) => r.id}
          label={(r) => <>{r.label}{r.variant && <span className="pill">{r.variant}</span>}{r.is_default && <span className="pill pill-accepted">default</span>}</>}
          selected={pickResumes}
          toggle={toggle(setPickResumes)}
        />
        <Picker
          title="Job descriptions"
          items={postings}
          id={(p) => p.id}
          label={(p) => <>{p.title} <span className="muted small">· {p.organization_name}</span></>}
          selected={pickPostings}
          toggle={toggle(setPickPostings)}
          hint="Roles you've intaked. Judge runs against the JD's stored requirements."
        />
      </div>

      {exported && (
        <details className="card" open>
          <summary>
            {exported === "[]"
              ? "Tuning data — empty; rate some analyses first"
              : "Tuning data (copied to clipboard)"}
          </summary>
          <pre className="bench-export">{exported}</pre>
        </details>
      )}

      {orderedPostings.map((r) => {
        const posting = r.posting!;
        const selected = r.resumes.filter((e) => pickResumes.has(e.resume_id));
        return (
          <section key={posting.id} className="bench-result">
            <div className="section-head">
              <h2>{posting.title} <span className="muted small">· {posting.organization_name}</span></h2>
              {posting.role_type && <span className="pill">{posting.role_type}</span>}
            </div>
            <div className="cols">
              {selected.map((entry) => (
                <AnalysisCard
                  key={entry.resume_id}
                  entry={entry}
                  postingId={posting.id}
                  onSaved={(rid, patch) => patchEval(posting.id, rid, patch)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {orderedPostings.length === 0 && !running && (
        <p className="muted">Select résumés + JDs above and hit Run to see analyses here.</p>
      )}
    </div>
  );
}
