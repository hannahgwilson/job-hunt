import { useEffect, useState } from "react";
import { fetchProspects, promoteProspectContact, saveProspectContact } from "../lib/api";
import { buildLinkedInSearchUrl, extractStatedManagerTitle, inferManagerTitles } from "../lib/hiringManagerSearch";
import type { CompanyConnection } from "../lib/types";

// "Find hiring manager" — the LinkedIn search launcher (Play: see CLAUDE.md
// company-page features). There's no accessible LinkedIn API, so this builds
// the right search and opens it for the user to run themselves, signed in as
// themselves — so it reflects their real network. Two ways to land on a
// title: (1) the JD states who the role reports to ("reports to the SVP of
// X") — extractStatedManagerTitle pulls that out of jdContext (whatever JD
// text is stored) or a line the user pastes directly, since this app doesn't
// store full JD bodies; (2) no stated title, so inferManagerTitles guesses a
// next-level-up title from the role's own function. Whoever they find gets
// saved as a 'prospect' contact (save_prospect_contact), separate from a
// confirmed CRM contact until promoted (promote_prospect_contact). Used on
// the role pages (title pre-filled from the posting) and the company page
// (title left blank, no JD to draw from).
export default function FindHiringManager({
  organizationId,
  organizationName,
  roleTitle,
  jdContext,
}: {
  organizationId: string;
  organizationName: string;
  roleTitle?: string;
  jdContext?: string;
}) {
  const statedTitle = jdContext ? extractStatedManagerTitle(jdContext) : null;
  const ladderSuggestions = roleTitle ? inferManagerTitles(roleTitle) : [];
  const suggestions = statedTitle
    ? [statedTitle, ...ladderSuggestions.filter((s) => s !== statedTitle)]
    : ladderSuggestions;
  const [targetTitle, setTargetTitle] = useState(statedTitle ?? ladderSuggestions[0] ?? "");
  const [pastedLine, setPastedLine] = useState("");

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

      <div className="fhm-paste-row">
        <input
          value={pastedLine}
          onChange={(e) => {
            const value = e.target.value;
            setPastedLine(value);
            const extracted = extractStatedManagerTitle(value);
            if (extracted) setTargetTitle(extracted);
          }}
          placeholder='Or paste a line from the JD, e.g. "reports to the VP of Engineering"'
        />
      </div>

      {suggestions.length > 0 && (
        <div className="fhm-suggestions">
          {statedTitle && (
            <button
              key={statedTitle}
              className="ghost sm fhm-chip-jd"
              title="Stated in the JD"
              onClick={() => setTargetTitle(statedTitle)}
            >
              from JD: {statedTitle}
            </button>
          )}
          {suggestions.filter((s) => s !== statedTitle).map((s) => (
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
