import { useEffect, useState } from "react";
import { listBullets, upsertBullet, deleteBullet, reorderBullets } from "../lib/api";
import { BULLET_SECTIONS, type ResumeBullet, type BulletSection } from "../lib/types";

// The bullet library — reusable, tagged, orderable resume lines grouped by
// section. This is the raw material the assemble-resume generator draws on to
// build a JD-tailored one-pager (on the role pages). Add/edit/reorder/retire
// bullets here; synthesis themes can also be promoted into the library from the
// feedback panel (source = 'synthesis'). See migration 010.

interface Draft {
  id?: string;
  section: BulletSection;
  org_label: string;
  text: string;
  tags: string; // comma-separated in the form
}

const BLANK: Draft = { section: "Experience", org_label: "", text: "", tags: "" };

function parseTags(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

export default function BulletLibraryPanel() {
  const [bullets, setBullets] = useState<ResumeBullet[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function load() {
    return listBullets()
      .then(setBullets)
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!draft || !draft.text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await upsertBullet({
        id: draft.id,
        section: draft.section,
        text: draft.text.trim(),
        org_label: draft.org_label.trim() || null,
        tags: parseTags(draft.tags),
      });
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(b: ResumeBullet) {
    setError(null);
    try {
      await upsertBullet({ id: b.id, section: b.section, text: b.text, org_label: b.org_label, is_active: !b.is_active });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(b: ResumeBullet) {
    if (!confirm("Delete this bullet?")) return;
    setError(null);
    try { await deleteBullet(b.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  // Reorder within a section: swap with the neighbour, persist the new id order.
  async function move(section: BulletSection, index: number, dir: -1 | 1) {
    const inSection = bullets.filter((b) => b.section === section);
    const j = index + dir;
    if (j < 0 || j >= inSection.length) return;
    const reordered = [...inSection];
    [reordered[index], reordered[j]] = [reordered[j], reordered[index]];
    // optimistic: reflect immediately
    const others = bullets.filter((b) => b.section !== section);
    setBullets([...others, ...reordered].sort((a, b) => a.section.localeCompare(b.section)));
    try { await reorderBullets(reordered.map((b) => b.id)); await load(); }
    catch (e) { setError((e as Error).message); await load(); }
  }

  if (!loaded) return <p className="muted small">Loading bullet library…</p>;

  const total = bullets.length;

  return (
    <section className="card bullet-library">
      <div className="section-head">
        <h2>Bullet library <span className="muted small">· {total} bullet{total === 1 ? "" : "s"}</span></h2>
        {!draft && <button className="ghost sm" onClick={() => setDraft({ ...BLANK })}>+ Add bullet</button>}
      </div>

      <p className="muted small">
        Reusable, tagged lines grouped by section. The “Build a tailored resume”
        button on a role page picks the best of these for that JD. Retire a bullet
        (toggle ✓) to keep it without offering it to the generator.
      </p>

      {draft && (
        <div className="bullet-editor">
          <div className="bullet-editor-row">
            <select value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value as BulletSection })}>
              {BULLET_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              placeholder="Org / role label (optional, e.g. Acme — Staff Eng)"
              value={draft.org_label}
              onChange={(e) => setDraft({ ...draft, org_label: e.target.value })}
            />
          </div>
          <textarea
            className="bullet-text"
            placeholder="The bullet — a concrete, quantified accomplishment."
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
          <input
            placeholder="tags, comma-separated (leadership, python, metrics)"
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
          <div className="bullet-editor-actions">
            <button className="sm" disabled={busy || !draft.text.trim()} onClick={save}>
              {busy ? "Saving…" : draft.id ? "Save" : "Add"}
            </button>
            <button className="ghost sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      {total === 0 && !draft && (
        <p className="muted small">No bullets yet — add the lines you reuse across resumes.</p>
      )}

      {BULLET_SECTIONS.map((section) => {
        const inSection = bullets.filter((b) => b.section === section);
        if (inSection.length === 0) return null;
        return (
          <div className="bullet-section" key={section}>
            <h3 className="bullet-section-h">{section}</h3>
            <ul className="bullet-list">
              {inSection.map((b, i) => (
                <li key={b.id} className={`bullet-item${b.is_active ? "" : " retired"}`}>
                  <div className="bullet-move">
                    <button className="ghost xs" disabled={i === 0} onClick={() => move(section, i, -1)} title="Move up">↑</button>
                    <button className="ghost xs" disabled={i === inSection.length - 1} onClick={() => move(section, i, 1)} title="Move down">↓</button>
                  </div>
                  <div className="bullet-body">
                    <div className="bullet-line">{b.text}</div>
                    <div className="bullet-meta muted small">
                      {b.org_label && <span>{b.org_label}</span>}
                      {b.tags.length > 0 && <span> · {b.tags.map((t) => `#${t}`).join(" ")}</span>}
                      {b.source !== "manual" && <span className="pill xs"> {b.source}</span>}
                    </div>
                  </div>
                  <div className="bullet-actions">
                    <button className="ghost xs" onClick={() => toggleActive(b)} title={b.is_active ? "Retire (exclude from generator)" : "Reactivate"}>
                      {b.is_active ? "✓" : "✗"}
                    </button>
                    <button className="ghost xs" onClick={() => setDraft({ id: b.id, section: b.section, org_label: b.org_label ?? "", text: b.text, tags: b.tags.join(", ") })}>edit</button>
                    <button className="ghost xs danger" onClick={() => remove(b)}>del</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
