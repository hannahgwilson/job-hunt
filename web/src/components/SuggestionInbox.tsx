import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSuggestions, promoteSuggestion, dismissSuggestion } from "../lib/api";
import TierMenu from "./TierMenu";
import type { Suggestions, TaskPriority } from "../lib/types";

// Feature 2: the live SUGGESTED inbox — Open Brain job-search thoughts, CRM
// follow-ups coming due, and top unapplied roles. Add promotes to a real task;
// dismiss records a task_dismissal so it never returns.
export default function SuggestionInbox({ onPromoted }: { onPromoted: () => void }) {
  const [s, setS] = useState<Suggestions | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function load() { fetchSuggestions().then(setS).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  async function promote(key: string, p: TaskPriority) {
    try { await promoteSuggestion(key, p); load(); onPromoted(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function dismiss(key: string) {
    try { await dismissSuggestion(key); load(); }
    catch (e) { setErr((e as Error).message); }
  }

  if (err) return <p className="error small">{err}</p>;
  if (!s) return <p className="muted">Loading suggestions…</p>;

  const empty = s.open_brain.length + s.followups.length + s.roles.length === 0;
  if (empty) return <p className="muted">Nothing suggested right now — inbox clear.</p>;

  return (
    <div className="inbox">
      {s.open_brain.length > 0 && (
        <div className="inbox-group">
          <h3>From Open Brain <span className="count">{s.open_brain.length}</span></h3>
          <ul className="clean">
            {s.open_brain.map((t) => (
              <li key={t.key} className="sugg">
                <span className="sugg-body">
                  {t.thought_type === "task" && <span className="pill">task</span>}{" "}
                  <span className="sugg-text">{t.content}</span>
                </span>
                <span className="sugg-actions">
                  <TierMenu onPick={(p) => promote(t.key, p)} />
                  <button className="ghost sm" onClick={() => dismiss(t.key)} title="Dismiss">×</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.followups.length > 0 && (
        <div className="inbox-group">
          <h3>Follow-ups due <span className="count">{s.followups.length}</span></h3>
          <ul className="clean">
            {s.followups.map((f) => (
              <li key={f.key} className="sugg">
                <span className="sugg-body">
                  <strong>{f.name}</strong>{f.title ? `, ${f.title}` : ""}
                  {f.organization_name ? ` @ ${f.organization_name}` : ""}{" "}
                  <span className={`small ${f.overdue ? "overdue" : "muted"}`}>
                    {f.overdue ? "overdue" : "due"} {f.follow_up_date}
                  </span>
                </span>
                <span className="sugg-actions">
                  <TierMenu onPick={(p) => promote(f.key, p)} />
                  <button className="ghost sm" onClick={() => dismiss(f.key)} title="Dismiss">×</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.roles.length > 0 && (
        <div className="inbox-group">
          <h3>Top roles to apply <span className="count">{s.roles.length}</span></h3>
          <ul className="clean">
            {s.roles.map((r) => (
              <li key={r.key} className="sugg">
                <span className="sugg-body">
                  <Link to={`/posting/${r.job_posting_id}`}>{r.title}</Link>
                  {r.organization_name ? ` · ${r.organization_name}` : ""}
                  {r.score ? <span className="muted small"> · {Math.round(Number(r.score))}</span> : null}
                </span>
                <span className="sugg-actions">
                  <TierMenu onPick={(p) => promote(r.key, p)} />
                  <button className="ghost sm" onClick={() => dismiss(r.key)} title="Dismiss">×</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
