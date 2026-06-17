import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchResumeFeedback, synthesizeFeedback } from "../lib/api";
import { pct, alignClass } from "./RoleFitPanel";
import type { ResumeFeedbackRole, FeedbackSynthesis, FeedbackTheme } from "../lib/types";

// The Resumes-tab digest: everything every judge has said about THIS resume,
// pulled across all the roles it's been scored against. Leads with the
// synthesize-feedback judge's ranked, bucketed themes (the answer to "what's the
// highest-value edit to make"), and keeps the raw per-role feedback below for
// drill-down. The per-posting fit page (RoleFitPanel) shows the same role_fit
// rows one role at a time; this is the inverse cut. Data: get_resume_feedback;
// synthesis: the synthesize-feedback edge function (see api).

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function ThemeCard({ theme }: { theme: FeedbackTheme }) {
  return (
    <li className={`theme theme-${theme.priority}`}>
      <div className="theme-head">
        <span className={`pill priority-${theme.priority}`}>{theme.priority}</span>
        <strong className="theme-title">{theme.title}</strong>
        <span className="muted small theme-meta">
          {theme.category} · {theme.role_count} role{theme.role_count === 1 ? "" : "s"}
        </span>
      </div>
      <p className="small theme-rec">{theme.recommendation}</p>
      {theme.rationale && <p className="muted small">{theme.rationale}</p>}
      {theme.roles && theme.roles.length > 0 && (
        <p className="muted small theme-from">↳ {theme.roles.join(" · ")}</p>
      )}
    </li>
  );
}

function Synthesis({ synthesis, roleCount }: { synthesis: FeedbackSynthesis; roleCount: number }) {
  const themes = (synthesis.themes ?? [])
    .slice()
    .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || b.role_count - a.role_count);
  // Newer judgements since the synthesis was cached → flag it stale.
  const stale = synthesis.source_count != null && synthesis.source_count < roleCount;

  return (
    <div className="synthesis">
      {synthesis.headline && <p className="synthesis-headline">★ {synthesis.headline}</p>}
      <ol className="theme-list">
        {themes.map((t, i) => <ThemeCard key={i} theme={t} />)}
      </ol>
      <p className="muted small">
        synthesized {synthesis.synthesized_at ? new Date(synthesis.synthesized_at).toLocaleString() : ""}
        {synthesis.source_count != null ? ` · from ${synthesis.source_count} judge read${synthesis.source_count === 1 ? "" : "s"}` : ""}
        {synthesis.model ? ` · ${synthesis.model}` : ""}
        {stale && <span className="warn-text"> · {roleCount - (synthesis.source_count ?? 0)} new since — re-synthesize</span>}
      </p>
    </div>
  );
}

export default function ResumeFeedbackPanel({
  resumeId, resumeLabel,
}: {
  resumeId: string;
  resumeLabel: string;
}) {
  const [roles, setRoles] = useState<ResumeFeedbackRole[] | null>(null);
  const [synthesis, setSynthesis] = useState<FeedbackSynthesis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);

  useEffect(() => {
    setRoles(null);
    setSynthesis(null);
    setError(null);
    fetchResumeFeedback(resumeId)
      .then((r) => { setRoles(r.roles); setSynthesis(r.synthesis); })
      .catch((e) => setError(e.message));
  }, [resumeId]);

  async function synthesize() {
    setSynthesizing(true);
    setError(null);
    try {
      const fresh = await synthesizeFeedback(resumeId);
      if ((fresh as { success?: boolean }).success === false) {
        throw new Error((fresh as unknown as { error?: string }).error ?? "synthesis failed");
      }
      setRoles(fresh.roles);
      setSynthesis(fresh.synthesis);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSynthesizing(false);
    }
  }

  if (error) return <div className="feedback-panel"><h3>Judge feedback</h3><p className="error">{error}</p></div>;
  if (roles == null) return <p className="muted small">Loading judge feedback…</p>;

  if (roles.length === 0) {
    return (
      <div className="feedback-panel">
        <h3>Judge feedback</h3>
        <p className="muted small">
          No judges have scored “{resumeLabel}” yet. Score it against your roles
          above, or run the judge from a role's <Link to="/queue">fit page</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="feedback-panel">
      <div className="section-head">
        <h3>
          Judge feedback
          <span className="muted small"> · {roles.length} role{roles.length === 1 ? "" : "s"} judged</span>
        </h3>
        <button className="sm" onClick={synthesize} disabled={synthesizing}>
          {synthesizing ? "Synthesizing…" : synthesis ? "Re-synthesize" : "Synthesize across roles"}
        </button>
      </div>

      {synthesis && synthesis.themes && synthesis.themes.length > 0 ? (
        <Synthesis synthesis={synthesis} roleCount={roles.length} />
      ) : (
        <p className="muted small">
          {synthesizing
            ? "Clustering the feedback into ranked themes…"
            : "Synthesize to bucket every role's tweaks into a ranked, deduped plan."}
        </p>
      )}

      <details className="feedback-raw">
        <summary>Per-role feedback ({roles.length})</summary>
        <div className="feedback-roles">
          {roles.map((r) => (
            <details key={r.posting_id} className="card feedback-role">
              <summary>
                <span className={`score-badge ${alignClass(r.alignment)}`}>{pct(r.alignment)}</span>
                <Link to={`/posting/${r.posting_id}`} onClick={(e) => e.stopPropagation()}>
                  {r.title}
                </Link>
                <span className="muted small"> · {r.organization_name}</span>
              </summary>

              {r.summary && <p className="small">{r.summary}</p>}

              {r.spikes && r.spikes.length > 0 && (
                <div className="fit-list">
                  <h4 className="spikes-h">▲ Spikes</h4>
                  <ul>{r.spikes.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
              )}

              {r.gaps && r.gaps.length > 0 && (
                <div className="fit-list">
                  <h4 className="gaps-h">▽ Gaps</h4>
                  <ul>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                </div>
              )}

              {r.tweaks && r.tweaks.length > 0 && (
                <div className="fit-list">
                  <h4>Proposed tweaks</h4>
                  <ul>
                    {r.tweaks.map((t, i) => (
                      <li key={i}>
                        {t.section && <span className="tweak-section">{t.section}: </span>}
                        {t.suggestion}
                        {t.rationale && <div className="muted small">{t.rationale}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.judged_at && (
                <p className="muted small">
                  judged {new Date(r.judged_at).toLocaleString()}{r.model ? ` · ${r.model}` : ""}
                </p>
              )}
            </details>
          ))}
        </div>
      </details>
    </div>
  );
}
