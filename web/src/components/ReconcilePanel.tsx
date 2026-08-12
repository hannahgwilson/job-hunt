import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { completeInterview, fetchReconciliation, markOutcomeReviewed } from "../lib/api";
import { roundLabel } from "../lib/rounds";
import type { AdvanceDecision, ReconcileRow } from "../lib/types";

/**
 * Reconcile — correcting rounds after the fact, which is what makes every rate
 * on this tab mean anything.
 *
 * `advance_decision` gets written in the moment, optimistically. "They're moving
 * me forward" is true the day you type it and false three weeks later when the
 * loop dies, and nothing ever went back to fix it. The result is a pass rate
 * that reads far higher than reality — advance rounds piling up underneath
 * applications that ended in a rejection — and a "where do I lose?" cut pointing
 * at the wrong round.
 *
 * Two kinds of disagreement, and they're different problems:
 *
 *   contradicted — the app is terminal but its furthest round still says
 *                  'advance'. This actively distorts the metrics.
 *   undecided    — a completed round on 'hold' or with no verdict at all. This
 *                  merely withholds from them: it sits outside every rate.
 *
 * Nothing is auto-applied. A suggestion is derived from the application's own
 * terminal status and each row is accepted or left alone one at a time, because
 * the alternative — cascading rejections down onto rounds automatically — writes
 * losses that may never have happened.
 */

const DECISIONS: { value: AdvanceDecision; label: string; hint: string }[] = [
  { value: "advance", label: "Advanced", hint: "They moved me forward" },
  { value: "rejected", label: "Rejected", hint: "They passed — counts as a loss" },
  { value: "withdraw", label: "Withdrew", hint: "My call — held out of the rate entirely" },
  { value: "hold", label: "Hold", hint: "Still genuinely undecided" },
];

function whenLabel(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "undated";
}

function Row({ row, onDone }: { row: ReconcileRow; onDone: () => void }) {
  const [decision, setDecision] = useState<AdvanceDecision | null>(row.suggested_decision);
  const [rating, setRating] = useState<number | null>(row.rating);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"save" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!decision) return;
    setBusy("save"); setError(null);
    try {
      // Same call the debrief uses, so the application cascade and the status
      // history behave identically whether a verdict is recorded on the day or
      // corrected months later. Status is preserved — this is a verdict fix, not
      // a re-opening.
      await completeInterview({
        interviewId: row.interview_id,
        status: "completed",
        advanceDecision: decision,
        rating: rating ?? undefined,
        decisionNotes: note.trim() || undefined,
      });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(null); }
  }

  async function keepAsIs() {
    setBusy("keep"); setError(null);
    try {
      await markOutcomeReviewed(row.interview_id, note.trim() || "reviewed — round was fine, loop ended elsewhere");
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(null); }
  }

  const stale = row.issue === "contradicted";

  return (
    <div className={`reconcile-row ${stale ? "is-contradicted" : ""}`}>
      <div className="reconcile-head">
        <span>
          <Link to={`/role/${row.application_id}`}>{row.organization_name}</Link>
          {row.role_title && <span className="muted"> — {row.role_title}</span>}
        </span>
        <span className="muted small">{whenLabel(row.scheduled_at)}</span>
      </div>

      <p className="muted small reconcile-why">
        {stale ? (
          <>
            Application is <strong>{row.app_status}</strong>, but its furthest round
            {row.interview_type ? ` (${roundLabel(row.interview_type)})` : ""} still says{" "}
            <strong>advance</strong>. That counts as a pass in every rate above.
          </>
        ) : (
          <>
            {row.interview_type ? roundLabel(row.interview_type) : "This round"} completed
            {row.advance_decision === "hold" ? " and is still on hold" : " with no verdict"} — it's
            held out of every rate.
            {row.suggested_decision
              ? <> The application later went <strong>{row.app_status}</strong>.</>
              : <> The application is still live, so there's no outcome to infer from — your call.</>}
          </>
        )}
      </p>

      {row.feedback && <p className="small reconcile-feedback">{row.feedback}</p>}

      <div className="reconcile-controls">
        <fieldset className="iv-decision">
          <legend className="muted small">Verdict</legend>
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`ghost sm${decision === d.value ? " on" : ""}`}
              title={d.hint}
              disabled={!!busy}
              onClick={() => setDecision(d.value)}
            >
              {d.label}
              {row.suggested_decision === d.value && <span className="muted"> ·suggested</span>}
            </button>
          ))}
        </fieldset>

        <label className="muted small">
          How it went
          <span className="iv-stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`iv-star${rating != null && n <= rating ? " on" : ""}`}
                disabled={!!busy}
                aria-label={`${n} of 5`}
                onClick={() => setRating(rating === n ? null : n)}
              >
                ★
              </button>
            ))}
          </span>
        </label>
      </div>

      <input
        className="reconcile-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="one line for future you — why it ended here"
        disabled={!!busy}
      />

      <div className="prep-chat-actions">
        <button className="sm" disabled={!decision || !!busy} onClick={save}>
          {busy === "save" ? "…" : "Save verdict"}
        </button>
        {/* Only offered where there's a contradiction to dismiss. An undecided
            round has nothing to vouch for — leaving it alone is just not
            clicking anything. */}
        {stale && (
          <button
            className="ghost sm"
            disabled={!!busy}
            onClick={keepAsIs}
            title="The round genuinely went well and the loop ended for other reasons"
          >
            {busy === "keep" ? "…" : "Record is right — leave it"}
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export default function ReconcilePanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<ReconcileRow[] | null>(null);
  const [counts, setCounts] = useState<{ contradicted: number; undecided: number; actionable: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [showUndecided, setShowUndecided] = useState(false);

  function load() {
    fetchReconciliation()
      .then((r) => {
        setRows(r.rows ?? []);
        setCounts({ contradicted: r.contradicted, undecided: r.undecided, actionable: r.actionable });
      })
      // The RPC not being deployed yet shouldn't take the whole Outcomes tab
      // down — the rates above still work without it.
      .catch((e) => setError((e as Error).message));
  }

  useEffect(load, []);

  function refresh() {
    load();
    onChanged?.();
  }

  const contradicted = useMemo(() => (rows ?? []).filter((r) => r.issue === "contradicted"), [rows]);
  const undecided = useMemo(() => (rows ?? []).filter((r) => r.issue === "undecided"), [rows]);
  // Only rows carrying an inferred verdict can be bulk-applied. An undecided
  // round under a live application has nothing to infer from.
  const bulkable = useMemo(() => (rows ?? []).filter((r) => r.suggested_decision), [rows]);

  async function acceptAll() {
    setBulk(true); setError(null);
    try {
      // Sequential: each call can cascade an application's status, and firing
      // them at once would have several rounds of one app racing on it.
      for (const r of bulkable) {
        await completeInterview({
          interviewId: r.interview_id,
          status: "completed",
          advanceDecision: r.suggested_decision!,
        });
      }
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBulk(false); }
  }

  if (error) {
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Reconcile</h3>
        <p className="error small">{error}</p>
      </section>
    );
  }
  if (!rows) return <p className="muted small">Checking rounds against outcomes…</p>;
  if (rows.length === 0) {
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Reconcile</h3>
        <p className="muted small">
          Every completed round carries a verdict, and none of them contradict what happened to the
          application. The rates above are reading real data.
        </p>
      </section>
    );
  }

  return (
    <section className="card reconcile">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>
          Reconcile <span className="count">· {rows.length}</span>
        </h3>
        {bulkable.length > 0 && (
          <button className="sm" disabled={bulk} onClick={acceptAll}>
            {bulk ? "Applying…" : `Accept all ${bulkable.length} suggestions`}
          </button>
        )}
      </div>

      <p className="muted small">
        {counts && counts.contradicted > 0 && (
          <>
            <strong>{counts.contradicted}</strong> round{counts.contradicted === 1 ? "" : "s"} still
            marked <em>advance</em> under an application that ended.{" "}
          </>
        )}
        {counts && counts.undecided > 0 && (
          <>
            <strong>{counts.undecided}</strong> completed round{counts.undecided === 1 ? "" : "s"} with
            no verdict, sitting outside every rate.{" "}
          </>
        )}
        Suggestions come from each application's own outcome — nothing is applied until you say so,
        because a loop can die for reasons that had nothing to do with the round.
      </p>

      {contradicted.length > 0 && (
        <>
          <h4>Contradicts the outcome <span className="count">· {contradicted.length}</span></h4>
          {contradicted.map((r) => <Row key={r.interview_id} row={r} onDone={refresh} />)}
        </>
      )}

      {undecided.length > 0 && (
        <>
          <div className="section-head">
            <h4 style={{ margin: 0 }}>
              No verdict recorded <span className="count">· {undecided.length}</span>
            </h4>
            <button className="ghost sm" onClick={() => setShowUndecided(!showUndecided)}>
              {showUndecided ? "Hide" : "Show"}
            </button>
          </div>
          {/* Collapsed by default: contradictions actively skew the numbers,
              blanks only withhold from them, and a backlog of 18 blanks would
              bury the handful that matter. */}
          {showUndecided
            ? undecided.map((r) => <Row key={r.interview_id} row={r} onDone={refresh} />)
            : (
              <p className="muted small">
                These don't distort the rates — they're just missing from them. Worth clearing when
                you have a few minutes.
              </p>
            )}
        </>
      )}
    </section>
  );
}
