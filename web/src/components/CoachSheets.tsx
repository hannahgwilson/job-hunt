import { useEffect, useState } from "react";
import {
  fetchCoachingArtifact, generateConcerns, generateQuestionsToAsk, generateHype,
} from "../lib/api";
import type {
  CoachingArtifactKind, CoachingArtifactResult,
  ConcernsContent, QuestionsContent, HypeContent,
} from "../lib/types";

/**
 * The three per-round sheets ported from the interview-coach skill's commands
 * (docs/interview-coach-integration.md): concerns, questions to ask, and the
 * pre-interview hype sheet.
 *
 * All three are generated on demand and persisted as coaching_artifacts, so a
 * sheet generated last week is still here today without re-running the model —
 * these get read right before walking in, not right after generating.
 *
 * They share a shape (load saved -> generate -> render), so the fetch/generate
 * plumbing lives once in useSheet and each section only owns its rendering.
 */
function useSheet<T>(
  kind: CoachingArtifactKind,
  interviewId: string,
  generate: (id: string) => Promise<CoachingArtifactResult<T>>,
) {
  const [content, setContent] = useState<T | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchCoachingArtifact<T>(kind, interviewId)
      .then((r) => {
        if (!live) return;
        setContent((r.artifact?.content as T) ?? null);
        setGeneratedAt(r.artifact?.generated_at ?? null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [kind, interviewId]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await generate(interviewId);
      setContent((r.artifact?.content as T) ?? null);
      setGeneratedAt(r.artifact?.generated_at ?? null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return { content, generatedAt, busy, error, run };
}

function SheetShell({
  title, hint, busy, generatedAt, error, hasContent, onRun, children,
}: {
  title: string;
  hint: string;
  busy: boolean;
  generatedAt: string | null;
  error: string | null;
  hasContent: boolean;
  onRun: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        <h2>{title}</h2>
        <button className="ghost sm" onClick={onRun} disabled={busy}>
          {busy ? "Working…" : hasContent ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {!hasContent && !busy && <p className="muted small">{hint}</p>}
      {generatedAt && hasContent && (
        <p className="muted small">Generated {new Date(generatedAt).toLocaleString()}</p>
      )}
      {children}
    </section>
  );
}

const SEVERITY_CLASS: Record<string, string> = {
  dealbreaker: "pill-rejected",
  significant: "pill-warn",
  minor: "",
};

export function ConcernsSheet({ interviewId }: { interviewId: string }) {
  const { content, generatedAt, busy, error, run } = useSheet<ConcernsContent>("concerns", interviewId, generateConcerns);
  return (
    <SheetShell
      title="Concerns they'll raise"
      hint="The objections this interviewer is likely to have about you, ranked by damage — each with a counter."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          <p className="small"><strong>Biggest risk:</strong> {content.biggest_risk}</p>
          {content.concerns.map((c, i) => (
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

export function QuestionsSheet({ interviewId }: { interviewId: string }) {
  const { content, generatedAt, busy, error, run } = useSheet<QuestionsContent>("questions_to_ask", interviewId, generateQuestionsToAsk);
  return (
    <SheetShell
      title="Questions to ask"
      hint="Tailored to who's actually in this room — a question a peer can't answer is a wasted turn."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          <ul className="clean">
            {content.questions.map((q, i) => (
              <li key={i} className="prep-question">
                <p className="small"><strong>{q.question}</strong></p>
                {q.ask_who && <p className="muted small">Ask: {q.ask_who}</p>}
                <p className="muted small">Signals: {q.why_it_lands}</p>
                <p className="muted small">You learn: {q.what_the_answer_tells_you}</p>
              </li>
            ))}
          </ul>
          {content.avoid.length > 0 && (
            <>
              <h3>Skip this round</h3>
              <ul className="clean">
                {content.avoid.map((a, i) => <li key={i} className="muted small">{a}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </SheetShell>
  );
}

export function HypeSheet({ interviewId }: { interviewId: string }) {
  const { content, generatedAt, busy, error, run } = useSheet<HypeContent>("hype", interviewId, generateHype);

  function copyMarkdown() {
    if (!content) return;
    const md = [
      "## Why I belong in this room",
      ...content.hype_reel.map((h) => `- ${h}`),
      "",
      "## 3 concerns + counters",
      ...content.three_concerns.map((c) => `- **${c.concern}** → ${c.counter}`),
      "",
      "## 3 questions to ask",
      ...content.three_questions.map((q) => `- ${q}`),
      "",
      `**Focus cue:** ${content.focus_cue}`,
      ...(content.recovery_script ? ["", `**If I bomb one:** ${content.recovery_script}`] : []),
    ].join("\n");
    navigator.clipboard.writeText(md);
  }

  return (
    <SheetShell
      title="Pre-interview hype"
      hint="The thing you read ten minutes before — grounded in your actual scores and stories, not pep talk."
      busy={busy} generatedAt={generatedAt} error={error} hasContent={!!content} onRun={run}
    >
      {content && (
        <>
          <div className="section-head-actions">
            <button className="ghost sm" onClick={copyMarkdown}>Copy as markdown</button>
          </div>

          <div className="prep-focus">
            <h3>Focus cue</h3>
            <p><strong>{content.focus_cue}</strong></p>
          </div>

          <h3>Why you belong in this room</h3>
          <ul className="clean">
            {content.hype_reel.map((h, i) => <li key={i}>· {h}</li>)}
          </ul>

          <h3>3 concerns + counters</h3>
          <ul className="clean">
            {content.three_concerns.map((c, i) => (
              <li key={i} className="small"><strong>{c.concern}</strong> → {c.counter}</li>
            ))}
          </ul>

          <h3>3 questions to ask</h3>
          <ul className="clean">
            {content.three_questions.map((q, i) => <li key={i} className="small">{q}</li>)}
          </ul>

          {content.warmup && content.warmup.length > 0 && (
            <>
              <h3>10-minute warmup</h3>
              <ul className="clean">
                {content.warmup.map((w, i) => <li key={i} className="small">{i + 1}. {w}</li>)}
              </ul>
            </>
          )}

          {content.recovery_script && (
            <>
              <h3>If you bomb one mid-interview</h3>
              <p className="small">{content.recovery_script}</p>
            </>
          )}

          {/* Pre-mortem only comes back at directness 5 (Challenge Protocol). */}
          {content.pre_mortem && content.pre_mortem.length > 0 && (
            <>
              <h3>Pre-mortem</h3>
              <ul className="clean">
                {content.pre_mortem.map((p, i) => (
                  <li key={i} className="small"><strong>{p.failure_mode}</strong> — {p.prevention_cue}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </SheetShell>
  );
}
