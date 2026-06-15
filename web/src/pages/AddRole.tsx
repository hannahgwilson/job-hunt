import { useState, type FormEvent } from "react";
import { intakeRole, submitApplication } from "../lib/api";

export default function AddRole({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [org, setOrg] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState("");
  const [alsoApply, setAlsoApply] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { posting_id } = await intakeRole({
        organization_name: org,
        title,
        url: url || undefined,
        location: location || undefined,
        remote_policy: remote || undefined,
      });
      if (alsoApply && posting_id) await submitApplication(posting_id);
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
