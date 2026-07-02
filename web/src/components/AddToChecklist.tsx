import { useState } from "react";
import { addRoleTask } from "../lib/api";
import TierMenu from "./TierMenu";
import type { TaskPriority } from "../lib/types";

// Feature 1: tag a role for the checklist at a priority tier (e.g. "apply to
// Komodo ASAP"). Creates a domain='job-hunt', kind='apply' task linked to the
// posting via promote_suggestion('posting:<id>').
export default function AddToChecklist({
  jobPostingId, onAdded, alreadyAdded = false,
}: {
  jobPostingId: string;
  onAdded?: () => void;
  // True when this posting already has an open apply task on the checklist —
  // lets the star reflect prior sessions, not just clicks in this render.
  alreadyAdded?: boolean;
}) {
  const [added, setAdded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (added || alreadyAdded) return <span className="chip-added" title="On your checklist">★ on checklist</span>;

  return (
    <span className="add-checklist">
      <TierMenu
        label="★ Add"
        onPick={async (p: TaskPriority) => {
          try { await addRoleTask(jobPostingId, p); setAdded(true); onAdded?.(); }
          catch (e) { setErr((e as Error).message); }
        }}
      />
      {err && <span className="error small">{err}</span>}
    </span>
  );
}
