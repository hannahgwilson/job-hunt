import { useState } from "react";
import { closeRole, reopenRole } from "../lib/api";
import { CLOSED_REASON_LABELS, type ClosedReason } from "../lib/types";

// Close out a role (filled / pulled / not pursuing) — or reopen it. Posting-level
// state, so it works whether or not there's an application: closing a role I've
// applied to also moves that application to the terminal 'closed' status (handled
// server-side by close_role). Used on both the posting page (/posting/:id) and the
// application page (/role/:id).

const REASONS: ClosedReason[] = ["filled", "expired", "removed", "no_longer_interested", "duplicate", "other"];

export default function CloseRoleControl({
  jobPostingId,
  closedAt,
  closedReason,
  onChanged,
}: {
  jobPostingId: string;
  closedAt: string | null;
  closedReason: ClosedReason | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ClosedReason>("filled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doClose() {
    setBusy(true);
    setError(null);
    try {
      await closeRole(jobPostingId, reason);
      setOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doReopen() {
    setBusy(true);
    setError(null);
    try {
      await reopenRole(jobPostingId);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── already closed: show the badge + a reopen affordance ──
  if (closedAt) {
    const label = CLOSED_REASON_LABELS[closedReason ?? "other"];
    return (
      <div className="close-role closed">
        <span className="pill pill-closed" title={`Closed ${new Date(closedAt).toLocaleDateString()}`}>
          {label}
        </span>
        <button className="ghost sm" disabled={busy} onClick={doReopen}>
          {busy ? "…" : "Reopen"}
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  }

  // ── open role: a Close button that expands into a reason picker ──
  return (
    <div className="close-role">
      {!open ? (
        <button className="ghost sm" onClick={() => setOpen(true)}>Close role…</button>
      ) : (
        <span className="close-role-form">
          <select value={reason} onChange={(e) => setReason(e.target.value as ClosedReason)} disabled={busy}>
            {REASONS.map((r) => (
              <option key={r} value={r}>{CLOSED_REASON_LABELS[r]}</option>
            ))}
          </select>
          <button className="sm" disabled={busy} onClick={doClose}>{busy ? "…" : "Close"}</button>
          <button className="ghost sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        </span>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
