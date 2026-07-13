import { useEffect, useState } from "react";
import { fetchProspects, promoteProspectContact, saveProspectContact } from "../lib/api";
import { buildLinkedInSearchUrl, inferManagerTitles } from "../lib/hiringManagerSearch";
import type { CompanyConnection } from "../lib/types";

// "Find hiring manager" — the LinkedIn search launcher (Play: see CLAUDE.md
// company-page features). There's no accessible LinkedIn API, so this builds
// the right search (JD title, or an inferred next-level-up title) and opens it
// for the user to run themselves, signed in as themselves — so it reflects
// their real network. Whoever they find gets saved as a 'prospect' contact
// (save_prospect_contact), separate from a confirmed CRM contact until
// promoted (promote_prospect_contact). Used on both the role page (title
// pre-filled from the posting) and the company page (title left blank).
export default function FindHiringManager({
  organizationId,
  organizationName,
  roleTitle,
}: {
  organizationId: string;
  organizationName: string;
  roleTitle?: string;
}) {
  const suggestions = roleTitle ? inferManagerTitles(roleTitle) : [];
  const [targetTitle, setTargetTitle] = useState(suggestions[0] ?? "");

  const [prospects, setProspects] = useState<CompanyConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [foundTitle, setFoundTitle] = useState("");
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
        title: foundTitle || undefined,
        linkedinUrl: linkedinUrl || undefined,
        notes: targetTitle ? `Found via LinkedIn search for "${targetTitle}"` : undefined,
      });
      setName("");
      setFoundTitle("");
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
      <h2>Find hiring manager</h2>
      <p className="muted small">
        Opens a LinkedIn people search for the title below at {organizationName} — run signed in as
        yourself so it reflects your real network.
      </p>

      <div className="fhm-search-row">
        <input
          value={targetTitle}
          onChange={(e) => setTargetTitle(e.target.value)}
          placeholder="Title to search for (e.g. VP Engineering)"
        />
        <a
          className="ghost sm fhm-search-btn"
          href={buildLinkedInSearchUrl(targetTitle, organizationName)}
          target="_blank"
          rel="noreferrer"
        >
          Search LinkedIn ↗
        </a>
      </div>

      {suggestions.length > 0 && (
        <div className="fhm-suggestions">
          {suggestions.map((s) => (
            <button key={s} className="ghost sm" onClick={() => setTargetTitle(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {!formOpen ? (
        <button className="ghost sm" onClick={() => setFormOpen(true)}>+ I found someone</button>
      ) : (
        <div className="fhm-form">
          <div className="form-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            <input value={foundTitle} onChange={(e) => setFoundTitle(e.target.value)} placeholder="Their title" />
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
