import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { updateTask, reorderTasks } from "../lib/api";
import { TASK_TIERS, type Task, type TaskPriority } from "../lib/types";

// MY CHECKLIST — open job-hunt tasks grouped by priority tier, checkable, with
// native HTML5 drag-to-reorder WITHIN a tier and a per-task tier picker.
export default function Checklist({ tasks, onChanged }: { tasks: Task[]; onChanged: () => void }) {
  const [items, setItems] = useState<Task[]>(tasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setItems(tasks), [tasks]);

  async function complete(id: string) {
    setItems((xs) => xs.filter((t) => t.id !== id)); // optimistic drop from the open list
    try { await updateTask(id, { status: "done" }); onChanged(); }
    catch (e) { setErr((e as Error).message); onChanged(); }
  }

  async function reprioritize(id: string, priority: TaskPriority) {
    try { await updateTask(id, { priority }); onChanged(); }
    catch (e) { setErr((e as Error).message); }
  }

  async function drop(targetId: string, tier: TaskPriority) {
    const src = items.find((t) => t.id === dragId);
    setDragId(null);
    if (!src || src.id === targetId || src.priority !== tier) return; // reorder only within a tier
    const group = items.filter((t) => t.priority === tier && t.id !== src.id);
    const rest = items.filter((t) => t.priority !== tier);
    const idx = group.findIndex((t) => t.id === targetId);
    group.splice(idx < 0 ? group.length : idx, 0, src);
    setItems([...rest, ...group]); // optimistic
    try { await reorderTasks(group.map((t) => t.id)); onChanged(); }
    catch (e) { setErr((e as Error).message); onChanged(); }
  }

  if (items.length === 0)
    return <p className="muted">Checklist is empty — add from Suggested below, or a role's ★ Add.</p>;

  return (
    <div className="checklist">
      {err && <p className="error small">{err}</p>}
      {TASK_TIERS.map((tier) => {
        const group = items.filter((t) => t.priority === tier.key);
        if (group.length === 0) return null;
        return (
          <div key={tier.key} className="tier">
            <div className="tier-head">{tier.dot} {tier.label} <span className="count">{group.length}</span></div>
            <ul className="clean">
              {group.map((t) => (
                <li
                  key={t.id}
                  className={`task${dragId === t.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => drop(t.id, tier.key)}
                >
                  <span className="grip" title="Drag to reorder">⠿</span>
                  <input type="checkbox" onChange={() => complete(t.id)} title="Mark done" />
                  <span className="task-body">
                    <span className="task-title">{t.title}</span>
                    <TaskMeta t={t} />
                  </span>
                  <select
                    className="tier-select"
                    value={t.priority}
                    onChange={(e) => reprioritize(t.id, e.target.value as TaskPriority)}
                    title="Priority tier"
                  >
                    {TASK_TIERS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TaskMeta({ t }: { t: Task }) {
  const parts: ReactNode[] = [];
  if (t.job_posting_id && t.role_title)
    parts.push(
      <Link key="role" to={`/posting/${t.job_posting_id}`}>
        {t.organization_name ? `${t.organization_name} · ` : ""}{t.role_title}
      </Link>,
    );
  else if (t.organization_name) parts.push(<span key="org">{t.organization_name}</span>);
  if (t.contact_name) parts.push(<span key="ct">{t.contact_name}</span>);
  if (t.interview_at)
    parts.push(<span key="iv">{t.interview_type ?? "interview"} · {new Date(t.interview_at).toLocaleDateString()}</span>);
  if (t.due_date) parts.push(<span key="due" className="due">due {t.due_date}</span>);
  if (parts.length === 0) return null;
  return (
    <span className="task-meta muted">
      {parts.map((p, i) => <span key={i}>{i > 0 ? " · " : ""}{p}</span>)}
    </span>
  );
}
