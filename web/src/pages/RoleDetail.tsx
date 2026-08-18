import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { priorityComponents, priorityScore } from "../lib/priority";
import { fetchRole } from "../lib/api";
import RoleFitPanel, { useRoleFit } from "../components/RoleFitPanel";
import PriorityBreakdown from "../components/PriorityBreakdown";
import TailoredResumePanel from "../components/TailoredResumePanel";
import CloseRoleControl from "../components/CloseRoleControl";
import StatusActions from "../components/StatusActions";
import AddToChecklist from "../components/AddToChecklist";
import InterviewPrep from "../components/InterviewPrep";
import InterviewOutcome from "../components/InterviewOutcome";
import ScheduleInterviewForm from "../components/ScheduleInterviewForm";
import { DecodeSheet } from "../components/CoachSheets";
import { usePriorityWeights } from "../lib/usePriorityWeights";
import type { Application, Interview, StatusHistoryRow } from "../lib/types";

const DECISION_PILL: Record<string, string> = {
  advance: "pill-accepted",
  hold: "pill-warn",
  withdraw: "pill-withdrawn",
  rejected: "pill-rejected",
};

export default function RoleDetail() {
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<Application | null>(null);
  const [history, setHistory] = useState<StatusHistoryRow[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    fetchRole(id)
      .then((r) => { setApp(r.application); setHistory(r.history); setInterviews(r.interviews); })
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Same AI-scoring panel as the standalone fit page, keyed off this
  // application's posting (undefined until the application loads).
  const fit = useRoleFit(app?.job_postings?.id);
  const weights = usePriorityWeights();

  if (error) return <p className="error">{error}</p>;
  if (!app) return <p className="muted">Loading…</p>;

  const posting = app.job_postings;
  const comp = posting?.salary_min && posting?.salary_max
    ? `$${Math.round(posting.salary_min / 1000)}–${Math.round(posting.salary_max / 1000)}k`
    : null;
  const closing = posting?.closing_date
    ? `closes ${new Date(posting.closing_date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : null;
  const growthStage = fit.data?.posting?.growth_stage ?? null;
  // The same 0–100 the Pipeline ranks on, recomputed client-side from the same
  // inputs and the user's own weights (semantic/metrics/priority_score.yaml).
  const priority = fit.data?.posting
    ? priorityScore(priorityComponents(fit.data.posting), weights)
    : null;
  // The judge's strongest read, for the sub-line under the score.
  const bestFit = [...(fit.data?.resumes ?? [])]
    .filter((r) => r.fit?.alignment != null)
    .sort((a, b) => (b.fit!.alignment as number) - (a.fit!.alignment as number))[0] ?? null;

  return (
    <div className="page">
      <p><Link to="/pipeline">← Pipeline</Link></p>
      {/* The dossier hero: the verdict stated once, large, with the facts that
          qualify it. Everything below is the argument for the number. */}
      <div className="dossier-hero">
        <div>
          <div className="dossier-org">
            {posting?.organizations?.name}
            {growthStage && growthStage !== "unknown" && <> · {growthStage}-stage</>}
          </div>
          <h1 className="dossier-role">{posting?.title}</h1>
          <div className="dossier-facts">
            {[posting?.location, posting?.remote_policy, comp, closing]
              .filter(Boolean)
              .map((f, i) => <span key={i}>{f}</span>)}
            {posting?.url && <a href={posting.url} target="_blank" rel="noreferrer">posting ↗</a>}
          </div>
          <div className="dossier-actions" style={{ marginTop: "0.9rem" }}>
            <span className={`pill pill-${app.status}`}>{app.status}</span>
            <StatusActions app={app} onChanged={load} onError={setError} />
            {posting?.id && (
              <CloseRoleControl
                jobPostingId={posting.id}
                closedAt={posting.closed_at}
                closedReason={posting.closed_reason}
                onChanged={load}
              />
            )}
            {posting?.id && <AddToChecklist jobPostingId={posting.id} />}
          </div>
        </div>
        <div className="dossier-verdict">
          <span className={`dossier-vnum${priority == null ? " low" : priority >= 70 ? "" : priority >= 45 ? " mid" : " low"}`}>
            {priority ?? "—"}
          </span>
          <span className="dossier-vlabel">Priority</span>
          {bestFit && (
            <span className="dossier-vsub">
              {Math.round((bestFit.fit!.alignment as number) * 100)}% fit · {bestFit.label}
            </span>
          )}
          {!bestFit && <span className="dossier-vsub">not judged against your resumes</span>}
        </div>
      </div>

      {fit.data?.posting && (
        <PriorityBreakdown
          inputs={fit.data.posting}
          weights={weights}
          judges={{
            career: fit.data.career,
            growth: fit.data.growth,
            onJudgeCareer: fit.judgeCareer,
            onJudgeGrowth: fit.judgeGrowth,
            judgingCareer: fit.judgingCareer,
            judgingGrowth: fit.judgingGrowth,
            error: fit.error,
          }}
        />
      )}

      <RoleFitPanel
        data={fit.data}
        judging={fit.judging}
        onJudge={fit.judge}
        error={fit.error}
        onJudgeResume={fit.judgeResume}
        judgingResumeId={fit.judgingResumeId}
      />

      {posting?.id && (
        <TailoredResumePanel jobPostingId={posting.id} baseResumeId={fit.data?.recommended_resume_id} />
      )}

      {/* The JD decode lives here, on the ROLE, because that's what it's about
          (migration 026). Intake generates it once; every round's prep page
          reads this same artifact rather than re-decoding the same JD. */}
      {posting?.id && (
        <DecodeSheet jobPostingId={posting.id} hasStoredJd={posting.has_jd_text ?? false} />
      )}

      <div className="cols">
        <section className="card">
          <h2>Stage history</h2>
          <ol className="timeline">
            {history.map((h) => (
              <li key={h.id}>
                <span className="ts muted">{new Date(h.changed_at).toLocaleDateString()}</span>
                <span>{h.from_status ? `${h.from_status} → ` : ""}<strong>{h.to_status}</strong></span>
                {h.notes && <div className="muted small">{h.notes}</div>}
              </li>
            ))}
            {history.length === 0 && <li className="muted">No transitions yet.</li>}
          </ol>
        </section>

        <section className="card">
          <h2>Interviews</h2>
          {interviews.length === 0 && <p className="muted">None scheduled.</p>}
          {interviews.map((iv) => (
            <div key={iv.id} className="interview">
              <div className="iv-head">
                <strong>{iv.interview_type ?? "Interview"}</strong>
                <span className="muted">{iv.scheduled_at ? new Date(iv.scheduled_at).toLocaleString() : "unscheduled"}</span>
              </div>
              <div className="iv-meta">
                <span className="muted">{iv.status === "no_show" ? "no-show" : iv.status}</span>
                {iv.rating != null && <span> · {"★".repeat(iv.rating)}</span>}
                {iv.advance_decision && (
                  <span className={`pill ${DECISION_PILL[iv.advance_decision] ?? ""}`}>{iv.advance_decision}</span>
                )}
                {iv.competencies?.map((name) => (
                  <span className="pill competency-pill" key={name}>{name}</span>
                ))}
              </div>
              {iv.notes && <p className="muted small">{iv.notes}</p>}
              {iv.feedback && <p className="small">{iv.feedback}</p>}
              {iv.decision_notes && <p className="muted small">Decision: {iv.decision_notes}</p>}
              <InterviewPrep interviewId={iv.id} />
              <InterviewOutcome
                interview={iv}
                onChanged={(u) => setInterviews((cur) => cur.map((x) => (x.id === u.id ? { ...x, ...u } : x)))}
              />
            </div>
          ))}
          <ScheduleInterviewForm applicationId={app.id} onScheduled={load} />
        </section>
      </div>

      {app.notes && (
        <section className="card"><h2>Notes</h2><p>{app.notes}</p></section>
      )}
    </div>
  );
}
