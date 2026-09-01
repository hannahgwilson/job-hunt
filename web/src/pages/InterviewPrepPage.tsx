import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  fetchInterviewPrepSession, startInterviewPrep, runInterviewPrepResearch, synthesizeInterviewPrep,
} from "../lib/api";
import InterviewPrepChat from "../components/InterviewPrepChat";
import PrepPanel from "../components/PrepPanel";
import PrepResearch from "../components/PrepResearch";
import PrepSummary from "../components/PrepSummary";
import { ConcernsSheet, QuestionsSheet, HypeSheet, DecodeSheet } from "../components/CoachSheets";
import type { SheetStateListener } from "../components/CoachSheets";
import FitSpikes, { hasFitHighlights } from "../components/FitSpikes";
import { pct, alignClass } from "../components/RoleFitPanel";
import type { CoachingArtifactKind, InterviewPrepSession } from "../lib/types";

/* ──────────────────────────────────────────────────────────────────────────
   The prep page used to be nine equal-weight cards in one long scroll, in an
   order that didn't match the order you use them: the JD decode rendered sixth
   despite being the thing you read first, and the hype sheet — the page you
   open ten minutes before you walk in — sat at the very bottom of the longest
   scroll in the app. Half of it also didn't exist until you'd saved intake
   notes, so a first visit showed two cards and no hint that six more were
   coming.

   The rebuild is organised around WHEN you use each piece:

     Brief    — days out. What is this role, what will they probe, who's coming.
     Rehearse — the night before. The mock interview and what it concluded.
     Game day — ten minutes before. Hype, their objections, your questions.

   with one directive bar at the top that names the single next thing to do, and
   panels that state "locked, and here's why" instead of vanishing.
   ────────────────────────────────────────────────────────────────────────── */

const TABS = [
  { key: "brief", label: "Brief", blurb: "Days out — what this round is and who's in it" },
  { key: "rehearse", label: "Rehearse", blurb: "The night before — practise, then read the verdict" },
  { key: "gameday", label: "Game day", blurb: "Ten minutes before — what you actually walk in with" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTab(v: string | null): v is TabKey {
  return TABS.some((t) => t.key === v);
}

/** Calendar-day difference, so "tomorrow" doesn't depend on the time of day. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(then) - midnight(new Date())) / 86_400_000);
}

function whenLabel(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export default function InterviewPrepPage() {
  const { interviewId } = useParams<{ interviewId: string }>();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = isTab(params.get("tab")) ? (params.get("tab") as TabKey) : "brief";

  const [prep, setPrep] = useState<InterviewPrepSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intakeDraft, setIntakeDraft] = useState("");
  const [editingIntake, setEditingIntake] = useState(false);
  const [savingIntake, setSavingIntake] = useState(false);
  const [researching, setResearching] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);

  // Which coaching sheets already exist. Each sheet loads its own artifact and
  // reports back (see SheetStateListener) — that's what makes the step counter
  // and the "next thing to do" honest without a batch read.
  const [sheets, setSheets] = useState<Partial<Record<CoachingArtifactKind, boolean>>>({});
  const onSheetState = useCallback<SheetStateListener>((kind, has) => {
    setSheets((cur) => (cur[kind] === has ? cur : { ...cur, [kind]: has }));
  }, []);

  // Set by the directive bar: switch tab, then scroll the panel into view once
  // it's actually rendered.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const intakeRef = useRef<HTMLTextAreaElement>(null);

  function load() {
    if (!interviewId) return;
    fetchInterviewPrepSession(interviewId)
      .then((p) => {
        setPrep(p);
        if (p.session?.intake_notes && !intakeDraft) setIntakeDraft(p.session.intake_notes);
        // Fresh session: pre-fill the intake from the round's scheduling notes
        // (competencies, who you're meeting) instead of an empty box (D5).
        else if (!p.session && p.interview?.notes && !intakeDraft) setIntakeDraft(p.interview.notes);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [interviewId]);

  useEffect(() => {
    if (!scrollTo) return;
    // preventScroll, then scroll the whole panel — otherwise the browser's own
    // focus scroll wins and lands with the panel head above the fold.
    if (scrollTo === "pp-intake") intakeRef.current?.focus({ preventScroll: true });
    document.getElementById(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo(null);
  }, [scrollTo, tab]);

  function goTo(nextTab: TabKey, elementId?: string) {
    setParams(nextTab === "brief" ? {} : { tab: nextTab }, { replace: true });
    if (elementId) setScrollTo(elementId);
  }

  async function saveIntake(sourceThoughtId?: string) {
    if (!interviewId) return;
    setSavingIntake(true); setError(null);
    try {
      const fresh = await startInterviewPrep(interviewId, intakeDraft.trim() || undefined, sourceThoughtId);
      setPrep(fresh);
      setEditingIntake(false);
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

  if (error && !prep) return <p className="error">{error}</p>;
  if (!prep) return <p className="muted">Loading…</p>;
  if (!prep.success) return <p className="error">{prep.error ?? "Could not load this interview."}</p>;

  const session = prep.session;
  const hasIntake = !!session;
  const hasResearch = !!session?.research;
  const hasRehearsal = (session?.transcript ?? []).some((m) => m.kind === "user");
  const hasSummary = !!session?.synthesis;

  const days = daysUntil(prep.interview.scheduled_at);
  const imminent = days != null && days >= 0 && days <= 1;

  /* ── The flow, as data ───────────────────────────────────────────────────
     Every panel on the page is one of these steps. The list drives three
     things at once: the per-tab progress counts, each panel's locked state,
     and the single directive at the top. They can't drift apart because
     they're the same array. */
  const steps: Array<{
    key: string;
    tab: TabKey;
    target: string;
    done: boolean;
    /** Non-null = not available yet, and this is why. */
    locked: string | null;
    title: string;
    hint: string;
    cta: string;
    run?: () => void;
  }> = [
    {
      key: "intake", tab: "brief", target: "pp-intake", done: hasIntake, locked: null,
      title: "Tell the coach what this round covers",
      hint: "Topics, format, who's in the room. Everything else on this page is written from it.",
      cta: "Go to intake",
    },
    {
      key: "decode", tab: "brief", target: "pp-decode", done: !!sheets.decode, locked: null,
      title: "Decode the job description",
      hint: "The competencies they'll actually probe, each checked against your storybank. Once per role.",
      cta: "Go to decode",
    },
    {
      key: "research", tab: "brief", target: "pp-research", done: hasResearch,
      locked: hasIntake ? null : "Save your intake notes first — research reads them to know who to look up.",
      title: "Research who you're meeting",
      hint: prep.interviewer?.name
        ? `${prep.interviewer.name} is on the invite — pull their background before you rehearse.`
        : "Look up the people on the invite and what they each care about.",
      cta: "Run research",
      run: research,
    },
    {
      key: "rehearse", tab: "rehearse", target: "pp-mock", done: hasRehearsal,
      locked: hasResearch ? null : "Run research first — the mock interviewer plays the people it finds.",
      title: "Rehearse a few answers",
      hint: "Workshop a draft before you send it, or answer cold and take the score.",
      cta: "Open the mock",
    },
    {
      key: "summary", tab: "rehearse", target: "pp-summary", done: hasSummary,
      locked: hasResearch ? null : "Available once research has run.",
      title: "Generate your prep summary",
      hint: "Stories to tell, competencies to hit, and a straight read on whether you're ready.",
      cta: "Generate summary",
      run: synthesize,
    },
    {
      key: "concerns", tab: "gameday", target: "pp-concerns", done: !!sheets.concerns,
      locked: hasIntake ? null : "Save your intake notes first.",
      title: "Work out what they'll push back on",
      hint: "Their likely objections, ranked by damage, each with a counter.",
      cta: "Go to concerns",
    },
    {
      key: "questions", tab: "gameday", target: "pp-questions", done: !!sheets.questions_to_ask,
      locked: hasIntake ? null : "Save your intake notes first.",
      title: "Line up questions for this room",
      hint: "Written against who's actually interviewing you — a question a peer can't answer is a wasted turn.",
      cta: "Go to questions",
    },
    {
      key: "hype", tab: "gameday", target: "pp-hype", done: !!sheets.hype,
      locked: hasIntake ? null : "Save your intake notes first.",
      title: "Build your hype sheet",
      hint: "The one page you read ten minutes before you walk in.",
      cta: "Go to hype sheet",
    },
  ];

  // A round with no posting behind it has nothing to decode — drop the step
  // rather than leaving a directive that points at a panel that isn't rendered.
  if (!prep.role?.job_posting_id) {
    const i = steps.findIndex((s) => s.key === "decode");
    if (i >= 0) steps.splice(i, 1);
  }

  const doneCount = steps.filter((s) => s.done).length;
  // Normally the next open step in order. But if the round is today or
  // tomorrow, the hype sheet outranks everything upstream of it — there's no
  // point starting research the morning of.
  const next =
    (imminent ? steps.find((s) => s.key === "hype" && !s.done && !s.locked) : undefined) ??
    steps.find((s) => !s.done && !s.locked) ??
    null;

  const counts = (t: TabKey) => {
    const inTab = steps.filter((s) => s.tab === t);
    return { done: inTab.filter((s) => s.done).length, total: inTab.length };
  };
  const step = (key: string) => steps.find((s) => s.key === key)!;

  const when = days == null ? null : whenLabel(days);
  const time = prep.interview.scheduled_at
    ? new Date(prep.interview.scheduled_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;
  const roundType = (prep.interview.interview_type ?? "interview").replace(/_/g, " ");

  return (
    <div className="prep-page">
      <p className="pp-crumbs">
        <Link to={`/role/${prep.role.application_id}`}>← {prep.role.title}</Link>
        {" · "}
        <Link to={`/company/${prep.role.organization_id}`}>{prep.role.organization_name}</Link>
      </p>

      {/* The hero states what this round is and how close it is — the two facts
          that decide how much of the page is worth doing today. */}
      <div className="dossier-hero pp-hero">
        <div>
          <div className="dossier-org">{prep.role.organization_name} · {roundType} round</div>
          <h1 className="dossier-role">{prep.role.title}</h1>
          <div className="dossier-facts">
            {when && (
              <span className={`pp-when${days != null && days < 0 ? " is-past" : imminent ? " is-soon" : ""}`}>
                {when}{time && days != null && days >= 0 ? ` · ${time}` : ""}
              </span>
            )}
            {prep.interviewer && (
              <span>
                {prep.interviewer.name}
                {prep.interviewer.title ? `, ${prep.interviewer.title}` : ""}
              </span>
            )}
            {prep.company_intel.growth_stage && prep.company_intel.growth_stage !== "unknown" && (
              <span>{prep.company_intel.growth_stage}-stage</span>
            )}
          </div>
        </div>
        <div className="dossier-verdict">
          <span className={`dossier-vnum${prep.fit?.alignment == null ? " low" : prep.fit.alignment >= 0.7 ? "" : prep.fit.alignment >= 0.45 ? " mid" : " low"}`}>
            {prep.fit?.alignment != null ? pct(prep.fit.alignment) : "—"}
          </span>
          <span className="dossier-vlabel">Resume fit</span>
          <span className="dossier-vsub">
            {prep.fit?.resume_label ?? "not judged for this role"}
          </span>
        </div>
      </div>

      {error && <p className="error small">{error}</p>}

      {/* One directive. Not a list of eight things — the next one. */}
      {next ? (
        <div className="next-action pp-next">
          <span className="next-action-n">{doneCount}<span className="pp-next-den">/{steps.length}</span></span>
          <div>
            <div className="next-action-t">{next.title}</div>
            <div className="next-action-s">
              {imminent && next.key === "hype" ? `This round is ${when!.toLowerCase()} — this is the one to have. ` : ""}
              {next.hint}
            </div>
          </div>
          <span className="spacer" />
          <button
            onClick={() => (next.run ? next.run() : goTo(next.tab, next.target))}
            disabled={(next.key === "research" && researching) || (next.key === "summary" && synthesizing)}
          >
            {next.key === "research" && researching ? "Researching…"
              : next.key === "summary" && synthesizing ? "Synthesizing…"
              : next.cta}
          </button>
        </div>
      ) : (
        <div className="next-action pp-next is-done">
          <span className="next-action-n">{doneCount}<span className="pp-next-den">/{steps.length}</span></span>
          <div>
            <div className="next-action-t">You're prepped for this one</div>
            <div className="next-action-s">Every sheet is built. Open the hype sheet before you walk in.</div>
          </div>
          <span className="spacer" />
          <button onClick={() => goTo("gameday", "pp-hype")}>Open the hype sheet</button>
        </div>
      )}

      <div className="interviews-subnav pp-tabs" role="tablist" aria-label="Prep phase">
        {TABS.map((t) => {
          const c = counts(t.key);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`sub-tab${tab === t.key ? " active" : ""}`}
              onClick={() => goTo(t.key)}
              title={t.blurb}
            >
              {t.label}
              <span className={`pp-tab-count${c.done === c.total ? " is-done" : ""}`}>{c.done}/{c.total}</span>
            </button>
          );
        })}
      </div>
      <p className="muted small pp-tab-blurb">{TABS.find((t) => t.key === tab)!.blurb}</p>

      {/* Every tab stays mounted. The sheets each load their own artifact on
          mount, which is what feeds the progress counts above — and it keeps a
          half-typed mock-interview answer alive across a tab switch. */}
      <div className="pp-tabpanel" role="tabpanel" hidden={tab !== "brief"}>
        <PrepPanel
          id="pp-fit"
          title="Fit for this role"
          meta={prep.fit?.resume_label ?? undefined}
          actions={
            prep.fit?.alignment != null ? (
              <span className={`score-badge ${alignClass(prep.fit.alignment)}`}>{pct(prep.fit.alignment)}</span>
            ) : undefined
          }
        >
          {hasFitHighlights(prep.fit) ? (
            <>
              {prep.fit?.summary && <p className="small">{prep.fit.summary}</p>}
              <FitSpikes fit={prep.fit} />
            </>
          ) : (
            <p className="muted small">
              No resume fit scored for this role yet — run the AI judge on the{" "}
              <Link to={`/role/${prep.role.application_id}`}>role page</Link> and the spikes and
              gaps show up here.
            </p>
          )}
        </PrepPanel>

        {/* Keyed to the posting, not this round: a JD belongs to the role, so
            every round in the loop reads the same decode (migration 026). */}
        {prep.role?.job_posting_id && (
          <DecodeSheet
            jobPostingId={prep.role.job_posting_id}
            hasStoredJd={prep.role.has_jd_text ?? false}
            onState={onSheetState}
          />
        )}

        <PrepPanel
          id="pp-intake"
          title="Intake"
          state={hasIntake ? "ready" : "empty"}
          actions={
            hasIntake && !editingIntake ? (
              <button className="ghost sm" onClick={() => setEditingIntake(true)}>Edit</button>
            ) : undefined
          }
        >
          {hasIntake && !editingIntake ? (
            <p className="small pp-intake-saved">
              {session!.intake_notes || <span className="muted">No notes saved — the round's own notes were used.</span>}
            </p>
          ) : (
            <>
              <p className="muted small pp-hint">
                What does this interview cover — topics, format, who's involved? Research, the mock
                interviewer and every Game day sheet are written from this.
              </p>
              <textarea
                ref={intakeRef}
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
              <div className="pp-foot">
                <button onClick={() => saveIntake()} disabled={savingIntake}>
                  {savingIntake ? "Saving…" : hasIntake ? "Save intake" : "Start prep"}
                </button>
                {hasIntake && (
                  <button className="ghost sm" onClick={() => { setEditingIntake(false); setIntakeDraft(session!.intake_notes ?? ""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </PrepPanel>

        <PrepPanel
          id="pp-research"
          title="Who you'll meet"
          state={researching ? "working" : hasResearch ? "ready" : "empty"}
          locked={step("research").locked ?? undefined}
          meta={session?.research_generated_at
            ? `generated ${new Date(session.research_generated_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
            : undefined}
          actions={
            <button className="ghost sm" onClick={research} disabled={researching}>
              {researching ? "Researching…" : hasResearch ? "Regenerate" : "Run research"}
            </button>
          }
        >
          {!hasResearch && !researching && (
            <p className="muted small pp-hint">
              Nothing yet — research looks up the people on the invite, what they care about, and what
              this role really is.
            </p>
          )}
          {researching && <p className="muted small">Searching…</p>}
          {session?.research && <PrepResearch research={session.research} />}
        </PrepPanel>
      </div>

      <div className="pp-tabpanel" role="tabpanel" hidden={tab !== "rehearse"}>
        <PrepPanel
          id="pp-mock"
          title="Mock interview"
          state={hasRehearsal ? "ready" : "empty"}
          locked={step("rehearse").locked ?? undefined}
        >
          {session && (
            <InterviewPrepChat
              interviewId={interviewId!}
              transcript={session.transcript}
              onChanged={(transcript) => setPrep((prev) => prev && prev.session ? { ...prev, session: { ...prev.session, transcript } } : prev)}
            />
          )}
        </PrepPanel>

        <PrepPanel
          id="pp-summary"
          title="Prep summary"
          state={synthesizing ? "working" : hasSummary ? "ready" : "empty"}
          locked={step("summary").locked ?? undefined}
          meta={session?.synthesized_at
            ? `generated ${new Date(session.synthesized_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
            : undefined}
          actions={
            <button className="ghost sm" onClick={synthesize} disabled={synthesizing}>
              {synthesizing ? "Synthesizing…" : hasSummary ? "Regenerate" : "Generate"}
            </button>
          }
        >
          {!hasSummary && !synthesizing && (
            <p className="muted small pp-hint">
              Rehearse a bit first, then generate the closing sheet — stories to tell, competencies to
              hit, and a readiness read.
            </p>
          )}
          {session?.synthesis && <PrepSummary synthesis={session.synthesis} />}
        </PrepPanel>
      </div>

      <div className="pp-tabpanel" role="tabpanel" hidden={tab !== "gameday"}>
        {/* Hype first: it's the last thing generated and the first thing read.
            The other two are what it's built out of. */}
        {hasIntake ? (
          <>
            <HypeSheet interviewId={interviewId!} onState={onSheetState} />
            <ConcernsSheet interviewId={interviewId!} onState={onSheetState} />
            <QuestionsSheet interviewId={interviewId!} onState={onSheetState} />
          </>
        ) : (
          <PrepPanel
            title="Game day sheets"
            locked="Save your intake notes in the Brief tab first — all three sheets are written against who's in the room."
          />
        )}
      </div>
    </div>
  );
}
