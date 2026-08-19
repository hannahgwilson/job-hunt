import { useState } from "react";
import { Link } from "react-router-dom";
import { completeInterview } from "../lib/api";
import { roundLabel } from "../lib/rounds";
import type { AdvanceDecision, Interview, InterviewListRow } from "../lib/types";

// The rounds behind an Outcomes number — and the place to fix them (T3.4).
//
// Two jobs in one table, because they're the same motion:
//
//   * Audit — every rate on the Outcomes tab is a ratio over a handful of
//     rounds, so "62% at hiring manager" is only trustworthy if you can see
//     which four rounds that was. Same drill-down convention as the Dashboard's
//     By-status and Stage-funnel tables.
//   * Fix — most rounds arrive here carrying no verdict, and an undecided round
//     sits outside every rate on the page. Editing in place beats bouncing to
//     the Past tab and hunting for the row: click a star, click a decision, it
//     saves on the click.
//
// Writes go through the same `complete_interview` RPC as the full debrief form,
// with the round's current status preserved — this never re-opens or closes a
// round, it only fills in the two fields the analytics read. The RPC COALESCEs
// its arguments, so a rating save can't clobber a decision (or vice versa) —
// and, for the same reason, neither field can be *cleared* here.

const DECISIONS: { value: AdvanceDecision; label: string; hint: string }[] = [
  { value: "advance", label: "Advance", hint: "They moved me forward — counts toward the pass rate" },
  { value: "hold", label: "Hold", hint: "Waiting / undecided — stays out of the rate" },
  { value: "withdraw", label: "Withdraw", hint: "I pulled out — held out of the rate, and closes the application" },
  { value: "rejected", label: "Rejected", hint: "They passed — counts against the pass rate, and closes the application" },
];

// These two cascade to the application's own status (T1.2), so they're worth a
// beat of confirmation from a compact table where a mis-click is easy.
const TERMINAL: AdvanceDecision[] = ["rejected", "withdraw"];

function whenLabel(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "undated";
}

function RoundRow({
  iv,
  onChanged,
}: {
  iv: InterviewListRow;
  onChanged: (updated: Interview) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: { rating?: number; advanceDecision?: AdvanceDecision }) {
    setBusy(true);
    setError(null);
    try {
      // Keep the round's own status: this is a debrief amendment, not a
      // completion. (Everything reaching this table is already 'completed'.)
      const updated = await completeInterview({ interviewId: iv.id, status: iv.status, ...patch });
      onChanged(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function decide(d: AdvanceDecision) {
    if (d === iv.advance_decision) return;   // already set; the RPC can't clear it anyway
    if (
      TERMINAL.includes(d) &&
      !confirm(
        `Mark this round "${d}"?\n\nThat also closes the application at ${iv.organization_name} ` +
          `(${d === "rejected" ? "rejected" : "withdrawn"}), the same as the debrief form.`,
      )
    ) return;
    save({ advanceDecision: d });
  }

  return (
    <tr className={iv.advance_decision == null || iv.advance_decision === "hold" ? "round-open" : ""}>
      <td>
        {iv.application_id
          ? <Link to={`/role/${iv.application_id}`}>{iv.role_title ?? "Untitled role"}</Link>
          : <span>{iv.role_title ?? "Untitled role"}</span>}
        <span className="muted"> @ </span>
        <Link to={`/company/${iv.organization_id}`}>{iv.organization_name}</Link>
      </td>
      <td className="muted">{whenLabel(iv.scheduled_at)}</td>
      <td>{iv.interview_type ? roundLabel(iv.interview_type) : <span className="muted">untyped</span>}</td>
      <td>
        <span className="iv-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`iv-star${iv.rating != null && n <= iv.rating ? " on" : ""}`}
              disabled={busy}
              aria-label={`Rate ${n} of 5`}
              title={`Rate this round ${n}/5`}
              onClick={() => n !== iv.rating && save({ rating: n })}
            >
              ★
            </button>
          ))}
        </span>
      </td>
      <td>
        <span className="round-decide">
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`ghost sm${iv.advance_decision === d.value ? " on" : ""}`}
              title={d.hint}
              disabled={busy}
              onClick={() => decide(d.value)}
            >
              {d.label}
            </button>
          ))}
          {error && <span className="error small">{error}</span>}
        </span>
      </td>
    </tr>
  );
}

export default function RoundDrilldown({
  title,
  blurb,
  rows,
  onChanged,
  onClose,
}: {
  title: string;
  blurb?: string;
  rows: InterviewListRow[];
  onChanged: (updated: Interview) => void;
  onClose: () => void;
}) {
  return (
    <div className="round-drilldown">
      <div className="section-head">
        <h4>{title} <span className="count">{rows.length}</span></h4>
        <button className="ghost sm" onClick={onClose}>Close</button>
      </div>
      {blurb && <p className="muted small">{blurb}</p>}
      <p className="muted small">
        Click a star or a decision to save it on the spot — same fields, same call as the debrief
        form on the Past tab. <strong>Rejected</strong> and <strong>Withdraw</strong> also close the
        application out.
      </p>
      <div className="table-wrap">
        <table className="stage-table">
          <thead>
            <tr>
              <th>Round</th>
              <th>When</th>
              <th>Type</th>
              <th>Rating</th>
              <th>Do you move forward?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((iv) => <RoundRow key={iv.id} iv={iv} onChanged={onChanged} />)}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">None.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
