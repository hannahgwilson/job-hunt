import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAssembledResume, assembleResume, saveAssembledResume } from "../lib/api";
import type { AssembledResume } from "../lib/types";

// The JD-targeted one-pager generator on a role page. Calls the assemble-resume
// edge function, which AI-selects + orders the best bullets from the library for
// THIS posting and drafts a tailored resume. The draft is editable and saved back
// (assembled_resumes, one per posting). baseResumeId (the fit page's recommended
// variant) just labels the draft. See migration 010 + the assemble-resume fn.
export default function TailoredResumePanel({
  jobPostingId, baseResumeId,
}: {
  jobPostingId: string;
  baseResumeId?: string | null;
}) {
  const [assembled, setAssembled] = useState<AssembledResume | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(false);
    getAssembledResume(jobPostingId)
      .then((a) => { setAssembled(a); setDraft(a?.body_md ?? ""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, [jobPostingId]);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await assembleResume(jobPostingId, baseResumeId ?? undefined);
      setAssembled(fresh.assembled);
      setDraft(fresh.assembled?.body_md ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveAssembledResume({ job_posting_id: jobPostingId, body_md: draft, base_resume_id: baseResumeId ?? null });
      setAssembled((a) => (a ? { ...a, body_md: draft } : a));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const dirty = assembled != null && draft !== (assembled.body_md ?? "");

  return (
    <section className="card tailored-panel">
      <div className="section-head">
        <h2>Tailored resume</h2>
        <button onClick={build} disabled={busy}>
          {busy ? "Building…" : assembled ? "Rebuild from library" : "Build a tailored resume"}
        </button>
      </div>

      <p className="muted small">
        Picks the strongest bullets from your <Link to="/resume">library</Link> for
        this JD and drafts a one-pager. Edit it below — your changes are saved per role.
      </p>

      {error && <p className="error">{error}</p>}

      {!loaded ? (
        <p className="muted small">Loading…</p>
      ) : !assembled && !busy ? (
        <p className="muted small">Not built yet — hit “Build a tailored resume”.</p>
      ) : (
        <>
          {assembled?.rationale && <p className="small tailored-rationale">{assembled.rationale}</p>}
          <textarea
            className="resume-text tailored-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="The assembled one-pager (markdown)…"
          />
          <div className="tailored-actions">
            <button className="sm" disabled={saving || !dirty} onClick={save}>
              {saving ? "Saving…" : dirty ? "Save edits" : "Saved"}
            </button>
            <button className="ghost sm" onClick={copy}>{copied ? "Copied ✓" : "Copy markdown"}</button>
            {assembled?.generated_at && (
              <span className="muted small">
                generated {new Date(assembled.generated_at).toLocaleString()}
                {assembled.model ? ` · ${assembled.model}` : ""}
                {assembled.selected_bullet_ids?.length ? ` · ${assembled.selected_bullet_ids.length} bullets` : ""}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
