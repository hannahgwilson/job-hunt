import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fetchInterviewPrep } from "../lib/api";
import type { InterviewPrep as Prep } from "../lib/types";

// Feature 3 (v1 static assembly): an expandable prep card per interview, built
// from data the app already has — company growth intel, best role_fit, the
// interviewer contact, and OB company notes. The full AI-written flow (round
// two: research, a mock-interview rehearsal, a closing prep sheet) lives on
// its own page — see InterviewPrepPage / the "Full prep →" link below.
export default function InterviewPrep({ interviewId }: { interviewId: string }) {
  const [open, setOpen] = useState(false);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !prep) {
      setLoading(true); setErr(null);
      try { setPrep(await fetchInterviewPrep(interviewId)); }
      catch (e) { setErr((e as Error).message); }
      finally { setLoading(false); }
    }
  }

  return (
    <div className="prep">
      <button className="ghost sm" onClick={toggle}>{open ? "Hide prep" : "Prep ▾"}</button>
      {open && (
        <div className="prep-body">
          {loading && <p className="muted small">Assembling…</p>}
          {err && <p className="error small">{err}</p>}
          {prep && prep.success && (
            <>
              <p className="prep-stub">
                <Link to={`/interview-prep/${interviewId}`}>Full prep →</Link>
              </p>
              <PrepRow label="Company">
                {prep.company_intel.growth_stage
                  ? <span>{prep.company_intel.growth_stage}-stage</span>
                  : <span className="muted">growth not judged</span>}
                {prep.company_intel.notes.length > 0 && (
                  <span className="muted"> · {prep.company_intel.notes.length} OB note{prep.company_intel.notes.length === 1 ? "" : "s"}</span>
                )}
              </PrepRow>
              <PrepRow label="Fit">
                {prep.fit ? (
                  <>
                    <span>best résumé: {prep.fit.resume_label ?? "—"}{prep.fit.alignment != null ? ` · ${prep.fit.alignment.toFixed(2)}` : ""}</span>
                    {prep.fit.gaps && prep.fit.gaps.length > 0 && (
                      <div className="muted small">gaps: {prep.fit.gaps.join(", ")}</div>
                    )}
                  </>
                ) : <span className="muted">no fit read yet — run the judge on the role page</span>}
              </PrepRow>
              <PrepRow label="Interviewer">
                {prep.interviewer ? (
                  <span>
                    {prep.interviewer.name}{prep.interviewer.title ? `, ${prep.interviewer.title}` : ""}
                    {prep.interviewer.last_contacted
                      ? <span className="muted"> · last {prep.interviewer.last_contacted}</span>
                      : <span className="muted"> · no history</span>}
                  </span>
                ) : <span className="muted">not linked</span>}
              </PrepRow>
            </>
          )}
          {prep && !prep.success && <p className="muted small">{prep.error ?? "No prep available."}</p>}
        </div>
      )}
    </div>
  );
}

function PrepRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prep-row">
      <span className="prep-label">{label}</span>
      <span className="prep-val">{children}</span>
    </div>
  );
}
