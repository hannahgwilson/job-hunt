import { useState, type FormEvent } from "react";
import { intakeRole, runJudge, submitApplication } from "../lib/api";
import type { CareerTrajectory, GrowthStage } from "../lib/types";

export default function AddRole({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [org, setOrg] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState("");
  const [career, setCareer] = useState("");
  const [growth, setGrowth] = useState("");
  const [fit, setFit] = useState("");
  const [alsoApply, setAlsoApply] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          To auto-fill from a link, paste it to Claude and ask it to intake the role.
        </p>
        <form onSubmit={submit}>
          <label>Company<input required value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Anthropic" /></label>
          <label>Title<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior AI Engineer" /></label>
          <label>Posting URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
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
