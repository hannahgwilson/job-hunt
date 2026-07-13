import { useEffect, useState } from "react";
import { fetchProspects, promoteProspectContact, saveProspectContact } from "../lib/api";
import type { CompanyConnection } from "../lib/types";

// Prospects — people you found (on LinkedIn or elsewhere) for this company but
// haven't confirmed as a real contact yet. A prospect is a contacts row
// tagged ['job-hunt','prospect'] (save_prospect_contact); promoting it drops
// that tag and adds 'professional' (promote_prospect_contact), matching the
// tag convention in CLAUDE.md.
export default function ProspectsPanel({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const [prospects, setProspects] = useState<CompanyConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  function load() {
    fetchProspects(organizationId).then(setProspects).catch((e) => setLoadError((e as Error).message));
  }

  useEffect(load, [organizationId]);

  async function handleSave() {
    setBusy(true);
    setSaveError(null);
    try {
      await saveProspectContact({
        organizationId,
        name,
        title: title || undefined,
        linkedinUrl: linkedinUrl || undefined,
      });
      setName("");
      setTitle("");
      setLinkedinUrl("");
      setFormOpen(false);
      load();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePromote(contactId: string) {
    setPromotingId(contactId);
    setPromoteError(null);
    try {
      await promoteProspectContact(contactId);
      load();
    } catch (e) {
      setPromoteError((e as Error).message);
    } finally {
      setPromotingId(null);
    }
  }

  return (
    <section className="card fhm">
      <h2>Prospects</h2>
      <p className="muted small">
        People you've found at {organizationName} but haven't confirmed as a contact yet.
      </p>

      {!formOpen ? (
        <button className="ghost sm" onClick={() => setFormOpen(true)}>+ Add a contact</button>
      ) : (
        <div className="fhm-form">
          <div className="form-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Their title" />
          </div>
          <input
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            placeholder="LinkedIn profile URL"
          />
          <div className="fhm-form-actions">
            <button className="sm" disabled={busy || !name.trim()} onClick={handleSave}>
              {busy ? "…" : "Save prospect"}
            </button>
            <button className="ghost sm" disabled={busy} onClick={() => setFormOpen(false)}>Cancel</button>
          </div>
          {saveError && <p className="error small">{saveError}</p>}
        </div>
      )}

      {loadError && <p className="error small">{loadError}</p>}
      {prospects.length > 0 && (
        <ul className="fhm-prospect-list">
          {prospects.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>
              {p.title && <span className="muted"> · {p.title}</span>}
              {p.linkedin_url && (
                <a href={p.linkedin_url} target="_blank" rel="noreferrer" className="small"> profile ↗</a>
              )}
              <button
                className="ghost sm"
                disabled={promotingId === p.id}
                onClick={() => handlePromote(p.id)}
              >
                {promotingId === p.id ? "…" : "Mark as contact →"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {promoteError && <p className="error small">{promoteError}</p>}
    </section>
  );
}
