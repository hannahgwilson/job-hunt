import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getRoleFit, runJudge } from "../lib/api";
import type { ResumeFitEntry, RoleFitResponse } from "../lib/types";

// Posting-scoped fit page (distinct from RoleDetail, which is application-scoped).
// Shows what spikes / what doesn't for a specific role, side-by-side per resume,
// with a button to (re-)run the AI judge.

function pct(a: number | null): string {
  return a == null ? "—" : `${Math.round(a * 100)}%`;
}

function alignClass(a: number | null): string {
  if (a == null) return "score-low";
  if (a >= 0.7) return "score-high";
  if (a >= 0.45) return "score-mid";
  return "score-low";
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

export default function RoleFit() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<RoleFitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);

  useEffect(() => {
    if (!id) return;
    getRoleFit(id).then(setData).catch((e) => setError(e.message));
  }, [id]);

  async function judge() {
    if (!id) return;
    setJudging(true);
    setError(null);
    try {
      const fresh = await runJudge(id);
      // The function returns the same shape as get_role_fit on success.
      if ((fresh as RoleFitResponse).success === false) {
        throw new Error((fresh as unknown as { error?: string }).error ?? "judge failed");
      }
      setData(fresh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJudging(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const p = data.posting;
  if (!p) return <p className="error">Posting not found.</p>;

  const unjudged = p.experience_alignment == null;

  return (
    <div className="page">
      <p><Link to="/pipeline">← Pipeline</Link></p>
      <div className="page-head">
        <h1>{p.title}</h1>
        <button onClick={judge} disabled={judging}>
          {judging ? "Judging…" : unjudged ? "Run AI judge" : "Re-run AI judge"}
        </button>
      </div>
      <p className="muted">
        <Link to={`/company/${p.organization_id}`}>{p.organization_name}</Link>
        {p.location ? ` · ${p.location}` : ""}
        {p.remote_policy ? ` · ${p.remote_policy}` : ""}
        {p.url && <> · <a href={p.url} target="_blank" rel="noreferrer">posting ↗</a></>}
      </p>

      {unjudged && (
        <div className="card notice">
          This role hasn’t been judged against your resumes yet, so its experience
          fit is the neutral <strong>0.5</strong> default — that’s why the priority
          score is stuck around 65. Run the AI judge to score it for real.
        </div>
      )}

      <div className="cols">
        {data.resumes.length === 0 ? (
          <p className="muted">No resumes yet — add one on the <Link to="/resume">Resume</Link> page.</p>
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

      {(p.requirements?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Requirements</h2>
          <ul className="reqs">{p.requirements!.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
