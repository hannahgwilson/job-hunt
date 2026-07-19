import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { fetchJobChecklist, createTask, fetchActionQueue, dedupeJobTasks } from "../lib/api";
import Checklist from "../components/Checklist";
import SuggestionInbox from "../components/SuggestionInbox";
import ScheduleInterviewForm from "../components/ScheduleInterviewForm";
import type { Task, ActionQueue as Q } from "../lib/types";

export default function ActionQueue() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [q, setQ] = useState<Q | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  function loadTasks() { fetchJobChecklist().then(setTasks).catch((e) => setError(e.message)); }
  function loadQueue() { fetchActionQueue().then(setQ).catch((e) => setError(e.message)); }
  useEffect(() => {
    // Self-heal any duplicate role tasks (e.g. from before promote_suggestion
    // became idempotent) before showing the list. Cleanup failure is non-fatal —
    // don't blank the page over it.
    dedupeJobTasks().catch(() => {}).finally(loadTasks);
    loadQueue();
  }, []);

  async function addFreeform(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    try { await createTask({ title, priority: "normal" }); loadTasks(); }
    catch (e2) { setError((e2 as Error).message); }
  }

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="page">
      <h1>Action Queue</h1>

      <section className="card">
        <div className="section-head">
          <h2>My checklist</h2>
          <form className="add-task" onSubmit={addFreeform}>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Add a task…" />
            <button className="ghost sm" type="submit">Add</button>
          </form>
        </div>
        {tasks === null ? <p className="muted">Loading…</p> : <Checklist tasks={tasks} onChanged={loadTasks} />}
      </section>

      <section className="card">
        <h2>Suggested</h2>
        <p className="muted small">
          From your pipeline, Open Brain notes, and CRM follow-ups. Add what you'll act on; dismiss the rest.
        </p>
        <SuggestionInbox onPromoted={loadTasks} />
      </section>

      {q && q.upcoming_interviews.length > 0 && (
        <section className="card">
          <h2>Upcoming interviews <span className="count">{q.upcoming_interviews.length}</span></h2>
          <ul className="clean">
            {q.upcoming_interviews.map((i) => (
              <li key={i.interview_id}>
                <strong>{i.title}</strong> @ {i.organization_name}
                <span className="muted"> — {i.interview_type} · {new Date(i.scheduled_at).toLocaleString()}</span>
                {" · "}<Link to={`/interview-prep/${i.interview_id}`}>Prep →</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Applications waiting on a response past the follow-up threshold. */}
      {q && q.role_followups.length > 0 && (
        <section className="card">
          <h2>Follow up on applications <span className="count">{q.role_followups.length}</span></h2>
          <ul className="clean">
            {q.role_followups.map((r) => (
              <li key={r.application_id}>
                <Link to={`/role/${r.application_id}`}>{r.title}</Link>
                <span className="muted"> @ {r.organization_name} — {r.status}</span>
                {r.days_waiting != null && <span className="muted"> · {r.days_waiting}d waiting</span>}
                {r.url && <> · <a href={r.url} target="_blank" rel="noreferrer">posting ↗</a></>}
                <ScheduleInterviewForm applicationId={r.application_id} onScheduled={loadQueue} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Job-hunt contacts gone stale / never contacted — networking nudges. */}
      {q && q.networking.length > 0 && (
        <section className="card">
          <h2>Reach out <span className="count">{q.networking.length}</span></h2>
          <ul className="clean">
            {q.networking.map((c) => (
              <li key={c.contact_id}>
                <strong>{c.name}</strong>
                {c.title && <span className="muted"> · {c.title}</span>}
                {c.organization_name && <span className="muted"> @ {c.organization_name}</span>}
                <span className="muted"> — {c.last_contacted ? `last contacted ${new Date(c.last_contacted).toLocaleDateString()}` : "never contacted"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
