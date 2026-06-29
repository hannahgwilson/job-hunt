import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getRoleFit, runJudge, runCareerJudge, runGrowthJudge } from "../lib/api";
import type {
  ResumeFitEntry, RoleFitResponse, RoleType, ResumeVariant, RequirementScore, AdjacencyTier, RoleFit,
} from "../lib/types";

const ROLE_TYPE_LABEL: Record<RoleType, string> = {
  ic: "IC role",
  manager: "Manager role",
  hybrid: "Hybrid (player-coach)",
  unclear: "Role type unclear",
};

// A track mismatch is the costly one: an IC resume aimed at a manager role, or
// vice versa. hybrid / unclear roles and "other" resumes don't hard-conflict.
function trackMismatch(roleType: RoleType | null, variant: ResumeVariant | null): boolean {
  if (!roleType || !variant) return false;
  return (roleType === "manager" && variant === "ic") || (roleType === "ic" && variant === "manager");
}

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
  // Which single resume (if any) is being judged on its own card — distinct from
  // the panel-level "judge all" so only that card spins.
  const [busyResumeId, setBusyResumeId] = useState<string | null>(null);

  function load() {
    if (!postingId) return;
    getRoleFit(postingId).then(setData).catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Judge one resume against this posting (judge-fit's resume_id path) — for
  // scoring a newly-added variant without re-running the others.
  async function runOne(resumeId: string) {
    if (!postingId) return;
    setBusyResumeId(resumeId);
    setError(null);
    try {
      const fresh = await runJudge(postingId, resumeId);
      if (fresh.success === false) {
        throw new Error((fresh as unknown as { error?: string }).error ?? "judge failed");
      }
      setData(fresh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyResumeId(null);
    }
  }

  return {
    data,
    error,
    reload: load,
    judging: busy === "experience",
    judge: () => run("experience"),
    judgeResume: runOne,
    judgingResumeId: busyResumeId,
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

// The four-tier adjacency labels, ordered strongest→weakest. The score-* classes
// reuse the existing high/mid/low color ramp so the table reads at a glance.
export const TIER_META: Record<AdjacencyTier, { label: string; cls: string }> = {
  identical: { label: "Identical", cls: "score-high" },
  adjacent: { label: "Adjacent", cls: "score-high" },
  aware: { label: "Aware", cls: "score-mid" },
  gap: { label: "Gap", cls: "score-low" },
};

// The judge's per-requirement adjacency table — the chain-of-thought behind the
// alignment number. Collapsed by default; core (required) gaps are the rows worth
// reading, so we surface a quick count in the summary line.
export function RequirementTable({ rows }: { rows: RequirementScore[] }) {
  const coreGaps = rows.filter((r) => r.importance === "required" && r.tier === "gap").length;
  const adjacent = rows.filter((r) => r.tier === "adjacent").length;
  return (
    <details className="req-table">
      <summary>
        Requirement breakdown ({rows.length})
        {coreGaps > 0 && <span className="warn-text"> · {coreGaps} core gap{coreGaps > 1 ? "s" : ""}</span>}
        {adjacent > 0 && <span className="muted"> · {adjacent} adjacent</span>}
      </summary>
      <ul className="req-list">
        {rows.map((r, i) => {
          const meta = TIER_META[r.tier];
          return (
            <li key={i} className="req-row">
              <span className={`score-badge sm ${meta.cls}`}>{meta.label}</span>
              <div className="req-body">
                <div className="req-head">
                  <strong>{r.requirement}</strong>
                  {r.importance === "required" && <span className="pill">core</span>}
                  {r.rule && <span className="pill" title="Adjacency rule cited">{r.rule}</span>}
                </div>
                {r.evidence && <div className="muted small">{r.evidence}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// The judged body — summary, the per-requirement adjacency table, spikes/gaps,
// and proposed tweaks. Shared by the role page (FitCard) and the Tuning Bench so
// the two reads can't drift.
export function FitDetails({ fit }: { fit: RoleFit }) {
  return (
    <>
      {fit.summary && <p className="small">{fit.summary}</p>}

      {fit.requirement_scores && fit.requirement_scores.length > 0 && (
        <RequirementTable rows={fit.requirement_scores} />
      )}

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
    </>
  );
}

function FitCard({
  entry, recommended, roleType, onJudge, judging, disabled,
}: {
  entry: ResumeFitEntry;
  recommended: boolean;
  roleType: RoleType | null;
  onJudge?: (resumeId: string) => void;
  judging?: boolean;
  disabled?: boolean;
}) {
  const fit = entry.fit;
  const mismatch = trackMismatch(roleType, entry.variant);
  return (
    <section className={`card fit-card${recommended ? " recommended" : ""}`}>
      <div className="fit-card-head">
        <div>
          <strong>{entry.label}</strong>
          {entry.variant && <span className="pill">{entry.variant}</span>}
          {mismatch && <span className="pill pill-warn" title={`This is a ${roleType} role`}>⚠ track mismatch</span>}
          {recommended && <span className="pill pill-accepted">★ recommended</span>}
        </div>
        <span className={`score-badge ${alignClass(fit?.alignment ?? null)}`}>{pct(fit?.alignment ?? null)}</span>
      </div>

      {!fit ? (
        <div className="fit-unjudged">
          <p className="muted small">Not judged yet — score just this resume against the role.</p>
          {onJudge && (
            <button className="sm" disabled={judging || disabled} onClick={() => onJudge(entry.resume_id)}>
              {judging ? "Judging…" : "Judge this resume"}
            </button>
          )}
        </div>
      ) : (
        <>
          <FitDetails fit={fit} />

          <div className="fit-card-foot">
            {fit.judged_at && (
              <span className="muted small">
                judged {new Date(fit.judged_at).toLocaleString()}{fit.model ? ` · ${fit.model}` : ""}
              </span>
            )}
            {onJudge && (
              <button className="ghost sm" disabled={judging || disabled} onClick={() => onJudge(entry.resume_id)}>
                {judging ? "Judging…" : "Re-judge"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default function RoleFitPanel({
  data, judging, onJudge, error, onJudgeResume, judgingResumeId,
}: {
  data: RoleFitResponse | null;
  judging: boolean;
  onJudge: () => void;
  error?: string | null;
  onJudgeResume?: (resumeId: string) => void;
  judgingResumeId?: string | null;
}) {
  // Any judge in flight (panel-level "judge all" or a single card) blocks the
  // other judge buttons so reads can't race.
  const anyJudging = judging || judgingResumeId != null;
  // Before the first fit read lands: show the error if it failed, else loading —
  // never an eternal "Loading…" that hides why the judge panel is empty.
  if (!data) {
    return error
      ? <section className="card fit-section"><h2>Resume fit</h2><p className="error">{error}</p></section>
      : <p className="muted">Loading fit…</p>;
  }

  const unjudged = data.posting?.experience_alignment == null;
  const roleType = data.posting?.role_type ?? null;
  // The strongest judged resume — if it's the wrong track for this role, say so loudly.
  const best = [...data.resumes]
    .filter((r) => r.fit?.alignment != null)
    .sort((a, b) => (b.fit!.alignment as number) - (a.fit!.alignment as number))[0];
  const bestMismatch = best ? trackMismatch(roleType, best.variant) : false;

  return (
    <section className="card fit-section">
      <div className="section-head">
        <h2>
          Resume fit
          {roleType && <span className="pill" title="Role track judged from the JD">{ROLE_TYPE_LABEL[roleType]}</span>}
        </h2>
        <button onClick={onJudge} disabled={judging}>
          {judging ? "Judging…" : unjudged ? "Run AI judge" : "Re-run AI judge"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {bestMismatch && (
        <div className="notice notice-warn">
          ⚠ This reads as a <strong>{roleType === "manager" ? "people-management" : "hands-on IC"}</strong> role,
          but your best-matching resume is a <strong>{best.variant}</strong> variant. Submitting the wrong track is
          a real misalignment — lead with your {roleType === "manager" ? "manager" : "IC"} resume, or retarget this one.
        </div>
      )}

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
              roleType={roleType}
              onJudge={onJudgeResume}
              judging={judgingResumeId === entry.resume_id}
              disabled={anyJudging && judgingResumeId !== entry.resume_id}
            />
          ))
        )}
      </div>
    </section>
  );
}
