import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { fetchResume, saveResume } from "../lib/api";

// Plain-text upload only (.txt / .md). PDFs/DOCX would need a parser; paste the
// text instead. The stored text is what the agent scores experience_alignment
// against — see semantic/metrics/priority_score.yaml.
const ACCEPT = ".txt,.md,.markdown,text/plain,text/markdown";

export default function Profile() {
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchResume()
      .then((r) => {
        setText(r.resume_text ?? "");
        setFilename(r.resume_filename ?? null);
        setUpdatedAt(r.updated_at ?? null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setFilename(file.name);
      setSaved(false);
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveResume(text, filename ?? undefined);
      setUpdatedAt(new Date().toISOString());
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Resume</h1>
        <button disabled={busy || !text.trim()} onClick={save}>
          {busy ? "Saving…" : "Save resume"}
        </button>
      </div>

      <section className="card">
        <p className="muted small">
          Upload or paste your long-form resume. This is what the prioritization
          framework scores <strong>experience alignment</strong> against when
          ranking roles to apply for — it stays in your database, never in the repo.
        </p>

        <div className="file-row">
          <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={onFile} />
          <button className="ghost" onClick={() => fileInput.current?.click()}>
            Upload .txt / .md
          </button>
          <span className="muted small">or paste below — PDFs: copy the text in.</span>
        </div>

        <div className="resume-meta">
          {filename && <span className="muted small">📄 {filename}</span>}
          <span className="muted small">{words} words</span>
          {updatedAt && <span className="muted small">· saved {new Date(updatedAt).toLocaleString()}</span>}
          {saved && <span className="saved-tag">✓ saved</span>}
        </div>

        <textarea
          className="resume-text"
          value={text}
          onChange={(e) => { setText(e.target.value); setSaved(false); }}
          placeholder="Paste your full resume here…"
        />

        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
