import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getRoleFit, runJudge, runCareerJudge, runGrowthJudge } from "../lib/api";
import type { ResumeFitEntry, RoleFitResponse } from "../lib/types";

// The AI-scoring UI for one posting: a "Run judge" button, the better-fit
// verdict, and side-by-side per-resume fit cards. Shared by the standalone fit
// page (/posting/:id) and the application/role view (/role/:id) so the scoring
// output shows in both — see useRoleFit for the data/judge logic.

export function pct(a: number | null): string {
  return a == null ? "—" : `${Math.round(a * 100)}%`;
}

export function alignClass(a: number | null): string {
  if (a == null) return "score-low";
  if (a >= 0.7) return "score-high";
  if (a >= 0.45) return "score-mid";
  return "score-low";
}

// Fetch + (re-)judge a posting's fit. postingId may be undefined while a parent
// is still loading (e.g. RoleDetail waiting on its application) — it no-ops then.
type JudgeKind = "experience" | "career" | "growth";

const RUNNERS: Record<JudgeKind, (id: string) => Promise<RoleFitResponse>> = {
  experience: (id) => runJudge(id),
  career: runCareerJudge,
  growth: runGrowthJudge,
};

export function useRoleFit(postingId?: string) {
  const [data, setData] = useState<RoleFitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<JudgeKind | null>(null);

  useEffect(() => {
    if (!postingId) return;
    getRoleFit(postingId).then(setData).catch((e) => setError(e.message));
  }, [postingId]);

  async function run(kind: JudgeKind) {
    if (!postingId) return;
    setBusy(kind);
    setError(null);
    try {
      const fresh = await RUNNERS[kind](postingId);
      if ((fresh as RoleFitResponse).success === false) {
        throw new Error((fresh as unknown as { error?: string }).error ?? "judge failed");
      }
      setData(fresh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return {
    data,
    error,
    judging: busy === "experience",
    judge: () => run("experience"),
    judgingCareer: busy === "career",
    judgeCareer: () => run("career"),
    judgingGrowth: busy === "growth",
    judgeGrowth: () => run("growth"),
  };
}

function Verdict({ resumes }: { resumes: ResumeFitEntry[] }) {
  const judged = resumes
    .filter((r) => r.fit && r.fit.alignment != null)
    .sort((a, b) => (b.fit!.alignment as number) - (a.fit!.alignment as number));

  if (judged.length === 0) return null;

  const best = judged[0];
  const runnerUp = judged[1];
  const margin = runnerUp ? (best.fit!.alignment as number) - (runnerUp.fit!.alignment as number) : null;
  const close = margin != null && margin < 0.05;

  return (
    <div className={`verdict ${alignClass(best.fit!.alignment ?? null)}`}>
      <div className="verdict-main">
        <span className="verdict-label">Better fit</span>
        <strong className="verdict-track">{best.label}</strong>
        {best.variant && <span className="pill">{best.variant}</span>}
        <span className={`score-badge ${alignClass(best.fit!.alignment ?? null)}`}>{pct(best.fit!.alignment ?? null)}</span>
      </div>
      <div className="verdict-detail muted small">
        {judged.length > 1 ? (
          <>
            vs {judged.slice(1).map((r) => `${r.label} ${pct(r.fit!.alignment ?? null)}`).join(", ")}
            {close && <> · <span className="warn-text">close call — read both</span></>}
          </>
        ) : (
          <>only this resume judged so far — run the others to compare</>
        )}
      </div>
    </div>
  );
}

function FitCard({ entry, recommended }: { entry: ResumeFitEntry; recommended: boolean }) {
  const fit = entry.fit;
  return (
    <section className={`card fit-card${recommended ? " recommended" : ""}`}>
      <div className="fit-card-head">
        <div>
          <strong>{entry.label}</strong>
          {entry.variant && <span className="pill">{entry.variant}</span>}
          {recommended && <span className="pill pill-accepted">★ recommended</span>}
        </div>
        <span className={`score-badge ${alignClass(fit?.alignment ?? null)}`}>{pct(fit?.alignment ?? null)}</span>
      </div>

      {!fit ? (
        <p className="muted small">Not judged yet — run the AI judge to score this resume.</p>
      ) : (
        <>
          {fit.summary && <p className="small">{fit.summary}</p>}

          {fit.spikes && fit.spikes.length > 0 && (
            <div className="fit-list">
              <h4 className="spikes-h">▲ Spikes</h4>
              <ul>{fit.spikes.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}

          {fit.gaps && fit.gaps.length > 0 && (
            <div className="fit-list">
              <h4 className="gaps-h">▽ Gaps</h4>
              <ul>{fit.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </div>
          )}

          {fit.tweaks && fit.tweaks.length > 0 && (
            <details className="tweaks">
              <summary>Proposed tweaks ({fit.tweaks.length})</summary>
              <ul>
                {fit.tweaks.map((t, i) => (
                  <li key={i}>
                    {t.section && <span className="tweak-section">{t.section}: </span>}
                    {t.suggestion}
                    {t.rationale && <div className="muted small">{t.rationale}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {fit.judged_at && (
            <p className="muted small">
              judged {new Date(fit.judged_at).toLocaleString()}{fit.model ? ` · ${fit.model}` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default function RoleFitPanel({
  data, judging, onJudge, error,
}: {
  data: RoleFitResponse | null;
  judging: boolean;
  onJudge: () => void;
  error?: string | null;
}) {
  // Before the first fit read lands: show the error if it failed, else loading —
  // never an eternal "Loading…" that hides why the judge panel is empty.
  if (!data) {
    return error
      ? <section className="card fit-section"><h2>Resume fit</h2><p className="error">{error}</p></section>
      : <p className="muted">Loading fit…</p>;
  }

  const unjudged = data.posting?.experience_alignment == null;

  return (
    <section className="card fit-section">
      <div className="section-head">
        <h2>Resume fit</h2>
        <button onClick={onJudge} disabled={judging}>
          {judging ? "Judging…" : unjudged ? "Run AI judge" : "Re-run AI judge"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {unjudged && (
        <div className="notice">
          Not judged against your resumes yet, so experience fit is the neutral
          <strong> 0.5</strong> default — that’s why the priority score sits around
          65. Run the AI judge to score it for real.
        </div>
      )}

      <Verdict resumes={data.resumes} />

      <div className="cols">
        {data.resumes.length === 0 ? (
          <p className="muted">No resumes yet — add one on the <Link to="/resume">Resumes</Link> page.</p>
        ) : (
          data.resumes.map((entry) => (
            <FitCard
              key={entry.resume_id}
              entry={entry}
              recommended={entry.resume_id === data.recommended_resume_id}
            />
          ))
        )}
      </div>
    </section>
  );
}
