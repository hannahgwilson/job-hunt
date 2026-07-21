import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchInterviewPrepSession, startInterviewPrep, runInterviewPrepResearch, synthesizeInterviewPrep,
} from "../lib/api";
import InterviewPrepChat, { ratingPillClass } from "../components/InterviewPrepChat";
import type { InterviewPrepSession } from "../lib/types";

export default function InterviewPrepPage() {
  const { interviewId } = useParams<{ interviewId: string }>();
  const [prep, setPrep] = useState<InterviewPrepSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intakeDraft, setIntakeDraft] = useState("");
  const [savingIntake, setSavingIntake] = useState(false);
  const [researching, setResearching] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);

  function load() {
    if (!interviewId) return;
    fetchInterviewPrepSession(interviewId)
      .then((p) => {
        setPrep(p);
        if (p.session?.intake_notes && !intakeDraft) setIntakeDraft(p.session.intake_notes);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [interviewId]);

  async function saveIntake(sourceThoughtId?: string) {
    if (!interviewId) return;
    setSavingIntake(true); setError(null);
    try {
      const fresh = await startInterviewPrep(interviewId, intakeDraft.trim() || undefined, sourceThoughtId);
      setPrep(fresh);
    } catch (e) { setError((e as Error).message); }
    finally { setSavingIntake(false); }
  }

  async function research() {
    if (!interviewId) return;
    setResearching(true); setError(null);
    try { setPrep(await runInterviewPrepResearch(interviewId)); }
    catch (e) { setError((e as Error).message); }
    finally { setResearching(false); }
  }

  async function synthesize() {
    if (!interviewId) return;
    setSynthesizing(true); setError(null);
    try { setPrep(await synthesizeInterviewPrep(interviewId)); }
    catch (e) { setError((e as Error).message); }
    finally { setSynthesizing(false); }
  }

  function copyMarkdown() {
    const s = prep?.session?.synthesis;
    if (!s) return;
    const of = s.overall_feedback;
    const md = [
      ...(of ? [
        `## Overall (${of.rating})`,
        of.summary,
        ...(of.strengths.length ? [`**Strengths:** ${of.strengths.join("; ")}`] : []),
        ...(of.areas_to_improve.length ? [`**Improve:** ${of.areas_to_improve.join("; ")}`] : []),
        `**Readiness:** ${of.readiness}`,
        "",
      ] : []),
      "## Stories to tell",
      ...s.stories.map((x) => `- **${x.title}** — ${x.story}${x.best_for ? ` _(for: ${x.best_for})_` : ""}`),
      "",
      "## Competencies to focus on",
      ...s.competencies.map((x) => `- **${x.name}**${x.why_it_matters ? ` — ${x.why_it_matters}` : ""}${x.evidence ? ` (evidence: ${x.evidence})` : ""}`),
      "",
      "## Questions to ask",
      ...s.questions_to_ask.map((q) => `- ${q}`),
    ].join("\n");
    navigator.clipboard.writeText(md);
  }

  if (error && !prep) return <p className="error">{error}</p>;
  if (!prep) return <p className="muted">Loading…</p>;
  if (!prep.success) return <p className="error">{prep.error ?? "Could not load this interview."}</p>;

  const session = prep.session;

  return (
    <div className="page">
      <p>
        <Link to={`/role/${prep.role.application_id}`}>← {prep.role.title}</Link>
        {" · "}
        <Link to={`/company/${prep.role.organization_id}`}>{prep.role.organization_name}</Link>
      </p>
      <div className="page-head">
        <h1>Interview prep</h1>
        <span className="pill">{prep.interview.interview_type ?? "interview"}</span>
        {prep.interview.scheduled_at && (
          <span className="muted small">{new Date(prep.interview.scheduled_at).toLocaleString()}</span>
        )}
      </div>
      {error && <p className="error small">{error}</p>}

      <section className="card">
        <h2>Intake</h2>
        <p className="muted small">What does this interview cover — topics, format, who's involved?</p>
        <textarea
          rows={4}
          placeholder="e.g. 45-min behavioral round with Karan (Eng Manager) — focused on cross-functional leadership and how I handle ambiguous roadmaps…"
          value={intakeDraft}
          onChange={(e) => setIntakeDraft(e.target.value)}
        />
        {prep.ob_suggestions.length > 0 && (
          <div className="prep-ob-suggestions">
            <span className="muted small">From Open Brain:</span>
            <ul className="clean">
              {prep.ob_suggestions.map((t) => (
                <li key={t.thought_id} className="sugg">
                  <span className="sugg-body small">{t.content}</span>
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => setIntakeDraft((d) => (d ? `${d}\n\n${t.content}` : t.content))}
                  >
                    Insert
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button onClick={() => saveIntake()} disabled={savingIntake}>
          {savingIntake ? "Saving…" : session ? "Update intake" : "Start prep"}
        </button>
        {session?.intake_notes && (
          <div className="prep-intake-saved">
            <span className="muted small">Saved intake:</span>
            <p className="small">{session.intake_notes}</p>
          </div>
        )}
      </section>

      {session && (
        <section className="card">
          <div className="section-head">
            <h2>Research</h2>
            <button className="ghost sm" onClick={research} disabled={researching}>
              {researching ? "Researching…" : session.research ? "Regenerate" : "Run research"}
            </button>
          </div>
          {!session.research && !researching && (
            <p className="muted small">Nothing yet — run research to look up the role and the people you'll meet.</p>
          )}
          {researching && <p className="muted small">Searching…</p>}
          {session.research && (
            <>
              <h3>Who you'll meet</h3>
              <div className="cols">
                {(session.research.people ?? []).map((p, i) => {
                  const linkedin = p.sources?.find((s) => /linkedin\.com/i.test(s));
                  const otherSources = (p.sources ?? []).filter((s) => s !== linkedin);
                  return (
                    <div key={i} className="prep-person">
                      <div className="prep-person-head">
                        <strong>{p.name}</strong>
                        {p.title && <span className="muted"> · {p.title}</span>}
                        {p.likely_relationship && <span className="pill">{p.likely_relationship}</span>}
                      </div>
                      {linkedin && (
                        <p className="small"><a href={linkedin} target="_blank" rel="noreferrer">LinkedIn ↗</a></p>
                      )}
                      {p.background && <p className="small">{p.background}</p>}
                      {p.what_they_probably_care_about && p.what_they_probably_care_about.length > 0 && (
                        <p className="muted small">Cares about: {p.what_they_probably_care_about.join(", ")}</p>
                      )}
                      {otherSources.length > 0 && (
                        <p className="muted small">
                          {otherSources.map((s, j) => (
                            <a key={j} href={s} target="_blank" rel="noreferrer">source{otherSources.length > 1 ? ` ${j + 1}` : ""} </a>
                          ))}
                        </p>
                      )}
                    </div>
                  );
                })}
                {(session.research.people ?? []).length === 0 && (
                  <p className="muted small">No named attendees found — add names in the intake notes above and regenerate.</p>
                )}
              </div>

              <h3>About the role</h3>
              {session.research.role_summary && <p>{session.research.role_summary}</p>}
              {session.research.role_functions && session.research.role_functions.length > 0 && (
                <ul className="clean">
                  {session.research.role_functions.map((f, i) => <li key={i}>· {f}</li>)}
                </ul>
              )}

              {session.research.prep_focus && session.research.prep_focus.length > 0 && (
                <div className="prep-focus">
                  <h3>Focus on</h3>
                  <ul className="clean">
                    {session.research.prep_focus.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {session?.research && (
        <section className="card">
          <h2>Mock interview</h2>
          <InterviewPrepChat
            interviewId={interviewId!}
            transcript={session.transcript}
            onChanged={(transcript) => setPrep((prev) => prev && prev.session ? { ...prev, session: { ...prev.session, transcript } } : prev)}
          />
        </section>
      )}

      {session?.research && (
        <section className="card">
          <div className="section-head">
            <h2>Prep summary</h2>
            <button className="ghost sm" onClick={synthesize} disabled={synthesizing}>
              {synthesizing ? "Synthesizing…" : session.synthesis ? "Regenerate" : "Generate prep summary"}
            </button>
          </div>
          {!session.synthesis && !synthesizing && (
            <p className="muted small">Rehearse a bit first, then generate the closing bulleted sheet.</p>
          )}
          {session.synthesis && (
            <>
              <div className="section-head-actions">
                <button className="ghost sm" onClick={copyMarkdown}>Copy as markdown</button>
              </div>
              {session.synthesis.overall_feedback && (
                <div className="prep-feedback-card overall">
                  <div className="prep-msg-head">
                    <span className="pill">overall</span>
                    <span className={`pill ${ratingPillClass(session.synthesis.overall_feedback.rating)}`}>
                      {session.synthesis.overall_feedback.rating}
                    </span>
                  </div>
                  <p className="small">{session.synthesis.overall_feedback.summary}</p>
                  {session.synthesis.overall_feedback.strengths.length > 0 && (
                    <p className="small"><strong>Strengths:</strong> {session.synthesis.overall_feedback.strengths.join(" · ")}</p>
                  )}
                  {session.synthesis.overall_feedback.areas_to_improve.length > 0 && (
                    <p className="small"><strong>Improve:</strong> {session.synthesis.overall_feedback.areas_to_improve.join(" · ")}</p>
                  )}
                  <p className="small"><strong>Readiness:</strong> {session.synthesis.overall_feedback.readiness}</p>
                </div>
              )}
              <h3>Stories to tell</h3>
              <ul className="clean">
                {session.synthesis.stories.map((s, i) => (
                  <li key={i}><strong>{s.title}</strong> — {s.story}{s.best_for && <span className="muted small"> (for: {s.best_for})</span>}</li>
                ))}
              </ul>
              <h3>Competencies to focus on</h3>
              <ul className="clean">
                {session.synthesis.competencies.map((c, i) => (
                  <li key={i}>
                    <strong>{c.name}</strong>
                    {c.why_it_matters && <> — {c.why_it_matters}</>}
                    {c.evidence && <span className="muted small"> (evidence: {c.evidence})</span>}
                  </li>
                ))}
              </ul>
              <h3>Questions to ask</h3>
              <ul className="clean">
                {session.synthesis.questions_to_ask.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
