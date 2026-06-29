import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { listResumes, upsertResumeVariant, setDefaultResume, deleteResume, fetchFitCoverage } from "../lib/api";
import type { Resume, ResumeVariant, FitCoveragePosting } from "../lib/types";
import ResumeScoringPanel from "../components/ResumeScoringPanel";
import ResumeFeedbackPanel from "../components/ResumeFeedbackPanel";
import CareerProfilePanel from "../components/CareerProfilePanel";
import BulletLibraryPanel from "../components/BulletLibraryPanel";

// Resume management: multiple named variants (e.g. a senior-IC resume and a
// manager resume). The default variant is what get_resume()/the MCP read; the
// AI judge scores every variant against a posting so the fit page can recommend
// one. Plain-text upload (.txt/.md) or paste — see migration 004.
const ACCEPT = ".txt,.md,.markdown,text/plain,text/markdown";

const VARIANTS: { value: ResumeVariant; label: string }[] = [
  { value: "ic", label: "Senior IC" },
  { value: "manager", label: "Manager" },
  { value: "other", label: "Other" },
];

interface Draft {
  id?: string;
  label: string;
  variant: ResumeVariant;
  resume_text: string;
  resume_filename: string | null;
  is_default: boolean;
}

const BLANK: Draft = { label: "", variant: "ic", resume_text: "", resume_filename: null, is_default: false };

export default function Profile() {
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [coverage, setCoverage] = useState<FitCoveragePosting[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function loadCoverage() {
    fetchFitCoverage().then(setCoverage).catch((e) => setError(e.message));
  }

  function load(selectId?: string) {
    return listResumes()
      .then((rs) => {
        setResumes(rs);
        if (selectId) {
          const r = rs.find((x) => x.id === selectId);
          if (r) selectResume(r);
        } else if (!draft && rs.length > 0) {
          selectResume(rs[0]);
        } else if (rs.length === 0) {
          setDraft({ ...BLANK });
        }
      })
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
    loadCoverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectResume(r: Resume) {
    setError(null);
    setDraft({
      id: r.id,
      label: r.label,
      variant: (r.variant ?? "other") as ResumeVariant,
      resume_text: r.resume_text ?? "",
      resume_filename: r.resume_filename,
      is_default: r.is_default,
    });
  }

  function newDraft() {
    setError(null);
    setDraft({ ...BLANK, is_default: resumes.length === 0 });
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !draft) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = () =>
      setDraft({
        ...draft,
        resume_text: String(reader.result ?? ""),
        resume_filename: file.name,
        label: draft.label || file.name.replace(/\.[^.]+$/, ""),
      });
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await upsertResumeVariant({
        id: draft.id,
        label: draft.label.trim(),
        variant: draft.variant,
        resume_text: draft.resume_text,
        resume_filename: draft.resume_filename ?? undefined,
        is_default: draft.is_default,
      });
      await load(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    setError(null);
    try {
      await setDefaultResume(id);
      await load(draft?.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this resume? Its fit judgements will be removed too.")) return;
    setError(null);
    try {
      await deleteResume(id);
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  const words = draft?.resume_text.trim() ? draft.resume_text.trim().split(/\s+/).length : 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Resumes</h1>
        <button className="ghost" onClick={newDraft}>+ New resume</button>
      </div>

      <p className="muted small">
        Keep a variant per track — e.g. a senior-IC resume and a manager resume.
        The <strong>default</strong> is what the agent reads; the AI judge scores
        every variant against a role and recommends one on its fit page.
      </p>

      <div className="resume-tabs">
        {resumes.map((r) => (
          <button
            key={r.id}
            className={`resume-tab${draft?.id === r.id ? " active" : ""}`}
            onClick={() => selectResume(r)}
          >
            {r.is_default && <span className="default-star" title="default">★</span>}
            {r.label}
            {r.variant && <span className="muted small"> · {r.variant}</span>}
          </button>
        ))}
        {resumes.length === 0 && <span className="muted small">No resumes yet — add one.</span>}
      </div>

      {draft && (
        <section className="card">
          <div className="resume-editor-head">
            <input
              className="resume-label"
              value={draft.label}
              placeholder="Label (e.g. Senior IC)"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <select
              value={draft.variant}
              onChange={(e) => setDraft({ ...draft, variant: e.target.value as ResumeVariant })}
            >
              {VARIANTS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
            <label className="default-toggle">
              <input
                type="checkbox"
                checked={draft.is_default}
                disabled={draft.id != null && draft.is_default}
                onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })}
              />
              Default
            </label>
            <button disabled={busy || !draft.label.trim() || !draft.resume_text.trim()} onClick={save}>
              {busy ? "Saving…" : draft.id ? "Save" : "Create"}
            </button>
            {draft.id && (
              <>
                {!draft.is_default && (
                  <button className="ghost sm" onClick={() => makeDefault(draft.id!)}>Make default</button>
                )}
                <button className="ghost sm danger" onClick={() => remove(draft.id!)}>Delete</button>
              </>
            )}
          </div>

          <div className="file-row">
            <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={onFile} />
            <button className="ghost" onClick={() => fileInput.current?.click()}>Upload .txt / .md</button>
            <span className="muted small">or paste below — PDFs: copy the text in.</span>
          </div>

          <div className="resume-meta">
            {draft.resume_filename && <span className="muted small">📄 {draft.resume_filename}</span>}
            <span className="muted small">{words} words</span>
          </div>

          <textarea
            className="resume-text"
            value={draft.resume_text}
            onChange={(e) => setDraft({ ...draft, resume_text: e.target.value })}
            placeholder="Paste this resume variant here…"
          />

          {error && <p className="error">{error}</p>}

          {draft.id && (
            <ResumeScoringPanel
              resumeId={draft.id}
              resumeLabel={draft.label}
              coverage={coverage}
              onDone={loadCoverage}
            />
          )}

          {draft.id && (
            <ResumeFeedbackPanel resumeId={draft.id} resumeLabel={draft.label} />
          )}
        </section>
      )}

      {!draft && error && <p className="error">{error}</p>}

      <BulletLibraryPanel />

      <CareerProfilePanel />
    </div>
  );
}
