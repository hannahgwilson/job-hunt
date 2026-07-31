import { useState, type FormEvent } from "react";
import { extractRoleFromUrl, intakeRole, runJudge, submitApplication } from "../lib/api";
import type { CareerTrajectory, GrowthStage } from "../lib/types";

export default function AddRole({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [org, setOrg] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState("");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");
  const [career, setCareer] = useState("");
  const [growth, setGrowth] = useState("");
  const [fit, setFit] = useState("");
  const [alsoApply, setAlsoApply] = useState(true);
  // Extracted by "Fetch from link" (T1.6) — carried into intake_role but shown
  // read-only: requirements feed the fit judge, not a hand-edited field.
  const [requirements, setRequirements] = useState<string[]>([]);
  const [intakeNotes, setIntakeNotes] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Play 1's enrichment step, in the UI: fetch the posting server-side and
  // prefill the form. Every field stays editable — the user reviews before
  // saving, which matters when the extracted salary drives the comp score.
  async function autofill() {
    if (!url) return;
    setFetching(true);
    setError(null);
    setFetchNote(null);
    try {
      const r = await extractRoleFromUrl(url);
      if (r.organization_name) setOrg(r.organization_name);
      if (r.title) setTitle(r.title);
      if (r.location) setLocation(r.location);
      if (r.remote_policy) setRemote(r.remote_policy);
      if (r.salary_min != null) setSalaryMin(String(r.salary_min));
      if (r.salary_max != null) setSalaryMax(String(r.salary_max));
      if (r.requirements?.length) setRequirements(r.requirements);
      if (r.notes) setIntakeNotes(r.notes);
      setFetchNote("Fields filled from the posting — check them (especially salary) before saving.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fitNum = fit === "" ? undefined : Number(fit);
      const { posting_id } = await intakeRole({
        organization_name: org,
        title,
        url: url || undefined,
        location: location || undefined,
        remote_policy: remote || undefined,
        salary_min: salaryMin === "" ? undefined : Number(salaryMin),
        salary_max: salaryMax === "" ? undefined : Number(salaryMax),
        requirements: requirements.length ? requirements : undefined,
        notes: intakeNotes || undefined,
        career_trajectory: (career || undefined) as CareerTrajectory | undefined,
        growth_stage: (growth || undefined) as GrowthStage | undefined,
        experience_alignment:
          fitNum !== undefined && !Number.isNaN(fitNum) ? fitNum : undefined,
      });
      if (alsoApply && posting_id) await submitApplication(posting_id);
      // Auto-judge new roles that weren't given a manual fit, so they don't sit
      // at the neutral 0.5 default (the "stuck at 65" problem). Fire-and-forget:
      // intake shouldn't block on two LLM calls, and the pipeline's realtime
      // subscription re-ranks the role when save_role_fit lands the score. If no
      // resume exists yet the judge no-ops — the fit page button stays available.
      if (posting_id && fitNum === undefined) {
        runJudge(posting_id).catch(() => { /* no resumes / transient — judge on demand later */ });
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2>Add a role</h2>
        <p className="muted small">
          Saves in one transaction: finds-or-creates the company, then the posting.
          Paste a posting link and <strong>Fetch from link</strong> fills the fields for review.
          Walled pages (LinkedIn, most ATSes) can't be read — type those in by hand.
        </p>
        <form onSubmit={submit}>
          <label>Posting URL
            <div className="form-row" style={{ alignItems: "center", gap: "0.5rem" }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={{ flex: 1 }} />
              <button type="button" className="ghost sm" disabled={!url || fetching} onClick={autofill}>
                {fetching ? "Fetching…" : "Fetch from link"}
              </button>
            </div>
          </label>
          {fetchNote && <p className="muted small">{fetchNote}</p>}
          <label>Company<input required value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Anthropic" /></label>
          <label>Title<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior AI Engineer" /></label>
          <div className="form-row">
            <label>Location<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Remote / NYC" /></label>
            <label>Remote policy
              <select value={remote} onChange={(e) => setRemote(e.target.value)}>
                <option value="">—</option>
                <option value="remote">remote</option>
                <option value="hybrid">hybrid</option>
                <option value="onsite">onsite</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>Salary min
              <input type="number" min="0" step="1000" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} placeholder="150000" />
            </label>
            <label>Salary max
              <input type="number" min="0" step="1000" value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} placeholder="190000" />
            </label>
          </div>
          {requirements.length > 0 && (
            <p className="muted small">
              Extracted requirements ({requirements.length}): {requirements.join(" · ")}
            </p>
          )}
          <p className="muted small">Prioritization signals (optional — feeds the force-ranking; Claude fills these from the JD + your resume). Leave <strong>Fit</strong> blank and the AI judge scores it against your resumes automatically.</p>
          <div className="form-row">
            <label>Career move
              <select value={career} onChange={(e) => setCareer(e.target.value)}>
                <option value="">—</option>
                <option value="step_up">step up</option>
                <option value="lateral">lateral</option>
                <option value="step_back">step back</option>
              </select>
            </label>
            <label>Company stage
              <select value={growth} onChange={(e) => setGrowth(e.target.value)}>
                <option value="">—</option>
                <option value="seed">seed</option>
                <option value="early">early</option>
                <option value="growth">growth</option>
                <option value="late">late</option>
                <option value="public">public</option>
                <option value="unknown">unknown</option>
              </select>
            </label>
            <label>Fit (0–1)
              <input
                type="number" min="0" max="1" step="0.05"
                value={fit} onChange={(e) => setFit(e.target.value)} placeholder="0.8"
              />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={alsoApply} onChange={(e) => setAlsoApply(e.target.checked)} />
            Mark as applied now (starts tracking)
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save role"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
