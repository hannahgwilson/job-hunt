import { useEffect, useState } from "react";
import {
  fetchCoachingArtifact, generateConcerns, generateQuestionsToAsk, generateHype, decodeRole,
} from "../lib/api";
import PrepPanel from "./PrepPanel";
import type {
  CoachingArtifactKind, CoachingArtifactResult,
  ConcernsContent, QuestionsContent, HypeContent, DecodeContent,
} from "../lib/types";

/**
 * Every list below comes out of a persisted model response. The generation
 * schemas mark these `required`, but a row written by an earlier schema — or a
 * response that came back a field short — used to throw straight through the
 * render and blank the whole app. Read them through this instead.
 */
function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Whether a sheet has been generated, reported up to whoever is showing prep
 * progress. Each sheet loads its own artifact, so the page can't know this
 * without either a second round of queries or this callback — and the callback
 * is what keeps "8 steps, 4 done" honest without a batch endpoint.
 */
export type SheetStateListener = (kind: CoachingArtifactKind, hasContent: boolean) => void;

/**
 * The per-round sheets ported from the interview-coach skill's commands
 * (docs/interview-coach-integration.md): concerns, questions to ask, the
 * pre-interview hype sheet, and the JD decode.
 *
 * All of them are generated on demand and persisted as coaching_artifacts, so a
 * sheet generated last week is still here today without re-running the model —
 * these get read right before walking in, not right after generating.
 *
 * They share a shape (load saved -> generate -> render), so the fetch/generate
 * plumbing lives once in useSheet and each section only owns its rendering.
 *
 * Two scopes, because decode isn't per-round: `interview` for the three sheets
 * that depend on who's in the room, `posting` for the JD decode, which is a
 * property of the ROLE and is generated once at intake (migration 026).
 */
function useSheet<T>(
  kind: CoachingArtifactKind,
  scopeId: string,
  generate: () => Promise<CoachingArtifactResult<T>>,
  scope: "interview" | "posting" = "interview",
  onState?: SheetStateListener,
) {
  const [content, setContent] = useState<T | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setContent(null);
    setGeneratedAt(null);
    fetchCoachingArtifact<T>(
      kind,
      scope === "interview" ? scopeId : undefined,
      scope === "posting" ? scopeId : undefined,
    )
      .then((r) => {
        if (!live) return;
        setContent((r.artifact?.content as T) ?? null);
        setGeneratedAt(r.artifact?.generated_at ?? null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [kind, scopeId, scope]);

  // Report presence up on every change, including the initial null — the
  // progress read is only trustworthy if "nothing saved" is stated as loudly as
  // "something saved". Listeners are expected to no-op on an unchanged value.
  useEffect(() => { onState?.(kind, content != null); }, [content, kind, onState]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await generate();
      setContent((r.artifact?.content as T) ?? null);
      setGeneratedAt(r.artifact?.generated_at ?? null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return { content, generatedAt, busy, error, run };
}

function SheetShell({
  id, title, hint, busy, generatedAt, error, hasContent, onRun, canRun = true, children,
}: {
  id?: string;
  title: string;
  hint: string;
  busy: boolean;
  generatedAt: string | null;
  error: string | null;
  hasContent: boolean;
  onRun: () => void;
  /** Sheets that need an input (decode) gate the button until it's supplied. */
  canRun?: boolean;
  children: React.ReactNode;
}) {
  return (
    <PrepPanel
      id={id}
      title={title}
      state={busy ? "working" : hasContent ? "ready" : "empty"}
      meta={generatedAt && hasContent ? `generated ${shortDate(generatedAt)}` : undefined}
      actions={
        <button className="ghost sm" onClick={onRun} disabled={busy || !canRun}>
          {busy ? "Working…" : hasContent ? "Regenerate" : "Generate"}
        </button>
      }
    >
      {error && <p className="error small">{error}</p>}
      {!hasContent && !busy && <p className="muted small pp-hint">{hint}</p>}
      {children}
    </PrepPanel>
  );
}

const SEVERITY_CLASS: Record<string, string> = {
  dealbreaker: "pill-rejected",
  significant: "pill-warn",
  minor: "",
};

export function ConcernsSheet({ interviewId, onState }: { interviewId: string; onState?: SheetStateListener }) {
  const { content, generatedAt, busy, error, run } = useSheet<ConcernsContent>(
    "concerns", interviewId, () => generateConcerns(interviewId), "interview", onState,
  );
  return (
    <SheetShell
      id="pp-concerns"
      title="Concerns they'll raise"
      hint="The objections this interviewer is likely to have about you, ranked by damage — each with a counter."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          {content.biggest_risk && (
            <p className="small"><strong>Biggest risk:</strong> {content.biggest_risk}</p>
          )}
          {arr(content.concerns).map((c, i) => (
            <div key={i} className="prep-feedback-card">
              <div className="prep-msg-head">
                <span className={`pill ${SEVERITY_CLASS[c.severity] ?? ""}`}>{c.severity}</span>
                <span className="muted small">{c.confidence} confidence</span>
              </div>
              <p className="small"><strong>{c.concern}</strong></p>
              <p className="muted small">Why they'll raise it: {c.why_they_will_raise_it}</p>
              <p className="small"><strong>Counter:</strong> {c.counter}</p>
              {c.story_to_use && <p className="muted small">Story: {c.story_to_use}</p>}
            </div>
          ))}
        </>
      )}
    </SheetShell>
  );
}

export function QuestionsSheet({ interviewId, onState }: { interviewId: string; onState?: SheetStateListener }) {
  const { content, generatedAt, busy, error, run } = useSheet<QuestionsContent>(
    "questions_to_ask", interviewId, () => generateQuestionsToAsk(interviewId), "interview", onState,
  );
  return (
    <SheetShell
      id="pp-questions"
      title="Questions to ask"
      hint="Tailored to who's actually in this room — a question a peer can't answer is a wasted turn."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          <ul className="clean">
            {arr(content.questions).map((q, i) => (
              <li key={i} className="prep-question">
                <p className="small"><strong>{q.question}</strong></p>
                {q.ask_who && <p className="muted small">Ask: {q.ask_who}</p>}
                {q.why_it_lands && <p className="muted small">Signals: {q.why_it_lands}</p>}
                {q.what_the_answer_tells_you && (
                  <p className="muted small">You learn: {q.what_the_answer_tells_you}</p>
                )}
              </li>
            ))}
          </ul>
          {arr(content.avoid).length > 0 && (
            <>
              <h3 className="pp-subhead">Skip this round</h3>
              <ul className="clean">
                {arr(content.avoid).map((a, i) => <li key={i} className="muted small">{a}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </SheetShell>
  );
}

const COVERAGE_CLASS: Record<string, string> = {
  strong_story: "pill-accepted",
  weak_story: "pill-warn",
  no_story: "pill-rejected",
  unknown: "",
};

const COVERAGE_LABEL: Record<string, string> = {
  strong_story: "strong story",
  weak_story: "weak story",
  no_story: "no story",
  unknown: "unknown",
};

/**
 * The model prefixes each signal with its own confidence ("HIGH: …"), which
 * read as shouting when rendered inline. Split it back out so the confidence
 * is a tag and the sentence is a sentence.
 */
function splitConfidence(line: string): { level: string | null; text: string } {
  const m = /^(HIGH|MEDIUM|LOW|UNKNOWN)\s*:\s*(.*)$/is.exec(line);
  return m ? { level: m[1].toLowerCase(), text: m[2] } : { level: null, text: line };
}

/**
 * The JD decode — competencies this role will actually probe for, each checked
 * against the storybank.
 *
 * Scoped to the POSTING, and generated once, at intake (migration 026). It used
 * to be per-interview-round, which meant nine identical model calls and nine
 * manual JD pastes for a nine-round loop. Every round at a company now reads the
 * same decode, so this component renders on the role page AND on each round's
 * prep page without re-running anything.
 *
 * `hasStoredJd` is whether intake captured the posting body. When it did, the
 * button just works. When it didn't (walled pages — LinkedIn, most ATSes), the
 * paste box appears, and the pasted text is stored on the posting so a later
 * regenerate doesn't ask again.
 *
 * The two long tails — what the wording signals, what to verify with the
 * recruiter — are folded away by default. Decode returns a lot of prose, and on
 * the prep page it used to bury the three sheets under it; the two lists that
 * change what you *do* (the competencies and the gaps) stay open.
 */
export function DecodeSheet({
  jobPostingId,
  hasStoredJd,
  onState,
}: {
  jobPostingId: string;
  hasStoredJd: boolean;
  onState?: SheetStateListener;
}) {
  const [jdText, setJdText] = useState("");
  const { content, generatedAt, busy, error, run } = useSheet<DecodeContent>(
    "decode", jobPostingId, () => decodeRole(jobPostingId, jdText.trim() || undefined), "posting", onState,
  );
  // The paste box is a fallback, not the normal path — it only shows when
  // there's no stored JD to run against.
  const needsPaste = !hasStoredJd;

  return (
    <SheetShell
      id="pp-decode"
      title="Decode the job description"
      hint={
        needsPaste
          ? "No JD stored for this role — that page couldn't be fetched at intake. Paste it once and it's kept for future runs."
          : "The competencies they'll actually probe for, each checked against your storybank. Runs once per role."
      }
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content}
      onRun={run} canRun={!needsPaste || jdText.trim().length > 0}
    >
      {/* No decode yet and nothing stored to read: the paste box IS the panel. */}
      {needsPaste && !content && (
        <textarea
          rows={5}
          className="prep-jd-input"
          placeholder="Paste the job description here…"
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
        />
      )}
      {content && (
        <>
          {/* Gaps first: they're the only part of the decode that's a to-do.
              Everything else is background for the room. */}
          {arr(content.coverage_gaps).length > 0 && (
            <div className="pp-callout">
              <h3 className="pp-subhead">Gaps to close before this round</h3>
              <ul className="clean">
                {arr(content.coverage_gaps).map((g, i) => <li key={i} className="small">{g}</li>)}
              </ul>
            </div>
          )}

          <h3 className="pp-subhead">Competencies they'll probe</h3>
          <ol className="clean pp-comps">
            {arr(content.competencies).map((c, i) => (
              <li key={i} className="pp-comp">
                <span className="pp-comp-rank">{c.priority}</span>
                <div className="pp-comp-body">
                  <div className="pp-comp-head">
                    <strong>{c.name}</strong>
                    {c.candidate_coverage && c.candidate_coverage !== "unknown" && (
                      <span className={`pill ${COVERAGE_CLASS[c.candidate_coverage] ?? ""}`}>
                        {COVERAGE_LABEL[c.candidate_coverage] ?? c.candidate_coverage}
                      </span>
                    )}
                  </div>
                  {c.evidence_in_jd && <p className="muted small">In the JD: {c.evidence_in_jd}</p>}
                  {c.covering_story && <p className="muted small">Story: {c.covering_story}</p>}
                </div>
              </li>
            ))}
          </ol>

          {arr(content.signals).length > 0 && (
            <details className="pp-more">
              <summary>What the wording signals <span className="count">{arr(content.signals).length}</span></summary>
              <ul className="clean">
                {arr(content.signals).map((s, i) => {
                  const { level, text } = splitConfidence(s);
                  return (
                    <li key={i} className="small pp-signal">
                      {level && <span className={`pp-conf is-${level}`}>{level}</span>}
                      <span className="muted">{text}</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {arr(content.verify_with_recruiter).length > 0 && (
            <details className="pp-more">
              <summary>
                Verify with the recruiter <span className="count">{arr(content.verify_with_recruiter).length}</span>
              </summary>
              <ul className="clean">
                {arr(content.verify_with_recruiter).map((v, i) => <li key={i} className="muted small">{v}</li>)}
              </ul>
            </details>
          )}

          {/* With a decode already on file the paste box isn't the thing to do
              — it's only the price of re-running one, so it goes last and
              folds away rather than leading the panel with an empty box. */}
          {needsPaste && (
            <details className="pp-more">
              <summary>Regenerating needs the JD pasted again</summary>
              <p className="muted small pp-hint">
                This posting's page couldn't be fetched, so there's nothing stored to re-read. Paste
                it once and it's kept for next time.
              </p>
              <textarea
                rows={5}
                className="prep-jd-input"
                placeholder="Paste the job description here…"
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
              />
            </details>
          )}
        </>
      )}
    </SheetShell>
  );
}

export function HypeSheet({ interviewId, onState }: { interviewId: string; onState?: SheetStateListener }) {
  const { content, generatedAt, busy, error, run } = useSheet<HypeContent>(
    "hype", interviewId, () => generateHype(interviewId), "interview", onState,
  );

  function copyMarkdown() {
    if (!content) return;
    const md = [
      "## Why I belong in this room",
      ...arr(content.hype_reel).map((h) => `- ${h}`),
      "",
      "## 3 concerns + counters",
      ...arr(content.three_concerns).map((c) => `- **${c.concern}** → ${c.counter}`),
      "",
      "## 3 questions to ask",
      ...arr(content.three_questions).map((q) => `- ${q}`),
      "",
      `**Focus cue:** ${content.focus_cue ?? ""}`,
      ...(content.recovery_script ? ["", `**If I bomb one:** ${content.recovery_script}`] : []),
    ].join("\n");
    navigator.clipboard.writeText(md);
  }

  return (
    <SheetShell
      id="pp-hype"
      title="Pre-interview hype"
      hint="The thing you read ten minutes before — grounded in your actual scores and stories, not pep talk."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          {content.focus_cue && (
            <div className="prep-focus">
              <h3>Focus cue</h3>
              <p><strong>{content.focus_cue}</strong></p>
            </div>
          )}

          <h3 className="pp-subhead">Why you belong in this room</h3>
          <ul className="clean">
            {arr(content.hype_reel).map((h, i) => <li key={i}>{h}</li>)}
          </ul>

          <h3 className="pp-subhead">3 concerns + counters</h3>
          <ul className="clean">
            {arr(content.three_concerns).map((c, i) => (
              <li key={i} className="small"><strong>{c.concern}</strong> → {c.counter}</li>
            ))}
          </ul>

          <h3 className="pp-subhead">3 questions to ask</h3>
          <ul className="clean">
            {arr(content.three_questions).map((q, i) => <li key={i} className="small">{q}</li>)}
          </ul>

          {arr(content.warmup).length > 0 && (
            <>
              <h3 className="pp-subhead">10-minute warmup</h3>
              <ol className="clean pp-warmup">
                {arr(content.warmup).map((w, i) => <li key={i} className="small">{w}</li>)}
              </ol>
            </>
          )}

          {content.recovery_script && (
            <>
              <h3 className="pp-subhead">If you bomb one mid-interview</h3>
              <p className="small">{content.recovery_script}</p>
            </>
          )}

          {/* Pre-mortem only comes back at directness 5 (Challenge Protocol). */}
          {arr(content.pre_mortem).length > 0 && (
            <details className="pp-more">
              <summary>Pre-mortem <span className="count">{arr(content.pre_mortem).length}</span></summary>
              <ul className="clean">
                {arr(content.pre_mortem).map((p, i) => (
                  <li key={i} className="small"><strong>{p.failure_mode}</strong> — {p.prevention_cue}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="pp-foot">
            <button className="ghost sm" onClick={copyMarkdown}>Copy as markdown</button>
          </div>
        </>
      )}
    </SheetShell>
  );
}
