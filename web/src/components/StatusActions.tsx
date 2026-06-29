import { useState } from "react";
import { advanceApplication } from "../lib/api";
import type { Application, ApplicationStatus } from "../lib/types";

// Forward funnel: where the "advance" button moves an app next. Terminal stages
// (accepted, rejected, withdrawn, closed) have no next step.
const NEXT: Record<string, ApplicationStatus | null> = {
  applied: "screening",
  screening: "interviewing",
  interviewing: "offer",
  offer: "accepted",
  accepted: null,
};

const TERMINAL: ApplicationStatus[] = ["accepted", "rejected", "withdrawn", "closed"];

// The status controls shared by the kanban card footer and the role page: advance
// one stage, or close the application out as rejected (their no) / withdrawn (my
// no). Both go through advance_application, so the status-history trigger logs
// every transition. Renders nothing once an application is terminal.
export default function StatusActions({
  app,
  onChanged,
  onError,
  compact,
}: {
  app: Application;
  onChanged: () => void;
  onError?: (msg: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function set(status: ApplicationStatus) {
    setBusy(true);
    try {
      await advanceApplication(app.id, status);
      onChanged();
    } catch (e) {
      onError?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (TERMINAL.includes(app.status)) return null;

  const next = NEXT[app.status];
  const cls = compact ? "ghost sm" : "ghost";
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      {next && (
        <button className={cls} disabled={busy} onClick={(e) => { stop(e); set(next); }}>
          → {next}
        </button>
      )}
      <button className={cls} disabled={busy} onClick={(e) => { stop(e); set("rejected"); }} title="They passed">
        Reject
      </button>
      <button className={cls} disabled={busy} onClick={(e) => { stop(e); set("withdrawn"); }} title="I'm pulling out">
        Withdraw
      </button>
    </>
  );
}
