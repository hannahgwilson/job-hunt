import { useState } from "react";
import { TASK_TIERS, type TaskPriority } from "../lib/types";

// A compact "add at a priority tier" control, shared by the role ★ Add button
// and the suggestion inbox. Reveals the tier options on click.
export default function TierMenu({
  label = "＋ Add",
  onPick,
  tiers = ["asap", "high", "normal"],
}: {
  label?: string;
  onPick: (p: TaskPriority) => Promise<void> | void;
  tiers?: TaskPriority[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<TaskPriority | null>(null);
  const opts = TASK_TIERS.filter((t) => tiers.includes(t.key));

  async function pick(p: TaskPriority) {
    setBusy(p);
    try { await onPick(p); setOpen(false); }
    finally { setBusy(null); }
  }

  return (
    <span className="tier-menu-wrap">
      <button className="ghost sm" onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <span className="tier-menu">
          {opts.map((t) => (
            <button key={t.key} className="tier-opt sm" disabled={busy !== null} onClick={() => pick(t.key)}>
              {busy === t.key ? "…" : `${t.dot} ${t.label}`}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
