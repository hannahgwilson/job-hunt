import { useEffect, useMemo, useState } from "react";
import { fetchPostingSignals } from "../lib/api";
import {
  byFitBand, byGrowthStage, byRoundType, byRecency, decidedRounds, overall, undecided, unrated,
  type OutcomeBucket, type PostingSignals,
} from "../lib/outcomes";
import RoundDrilldown from "./RoundDrilldown";
import type { Interview, InterviewListRow } from "../lib/types";

// Interviews → Outcomes (T3.2). "Which round types do I actually lose at?" —
// the most useful thing the debrief data can tell you, and nothing computed it
// until advance_decision started meaning something (T1.2).
//
// Three cuts over the same population of debriefed rounds. The rate convention
// matches the Dashboard's stage funnel (decided outcomes only, pending set
// aside) — see lib/outcomes.ts and semantic/metrics/round_pass_rate.yaml.
//
// T3.4 added the two things that make it usable rather than just readable:
// every row expands into the rounds behind it (the Dashboard's drill-down
// convention), and those rounds are editable in place — because the honest
// state of this dataset is that most rounds carry no verdict, and an undecided
// round sits outside every rate on the page.

// Below this many decided rounds a percentage is noise, so the table shows the
// counts and greys the rate rather than printing "0%" off one rejection.
const THIN = 3;

function Rate({ b }: { b: OutcomeBucket }) {
  const decided = b.advanced + b.lost;
  if (decided === 0) return <span className="muted">—</span>;
  const pct = Math.round(b.rate! * 100);
  return (
    <span className={decided < THIN ? "muted" : undefined} title={decided < THIN ? "Too few decided rounds to read as a rate" : undefined}>
      {pct}% <span className="muted">({b.advanced}/{decided})</span>
    </span>
  );
}

function OutcomeTable({
  title, blurb, buckets, openKey, onToggle, onChanged, onClose,
}: {
  title: string;
  blurb: string;
  buckets: OutcomeBucket[];
  /** Which bucket in *this* table is expanded, if any. */
  openKey: string | null;
  onToggle: (bucketKey: string) => void;
  onChanged: (updated: Interview) => void;
  onClose: () => void;
}) {
  const open = buckets.find((b) => b.key === openKey) ?? null;
  return (
    <section className="card outcome-cut">
      <h3>{title}</h3>
      <p className="muted small">{blurb}</p>
      <p className="muted small">Click a row to see — and fix — the rounds behind it.</p>
      <table className="stage-table">
        <thead>
          <tr>
            <th>{title.replace(/^By /, "")}</th>
            <th className="num">Rounds</th>
            <th className="num">Pass rate</th>
            <th className="num">Lost</th>
            <th className="num">Withdrew</th>
            <th className="num">Undecided</th>
            <th className="num">Avg rating</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr
              key={b.key}
              className={`${b.total > 0 ? "clickable" : ""}${openKey === b.key ? " active" : ""}`}
              onClick={b.total > 0 ? () => onToggle(b.key) : undefined}
            >
              <td>{b.label}</td>
              <td className="num">{b.total}</td>
              <td className="num"><Rate b={b} /></td>
              <td className="num">{b.lost || <span className="muted">—</span>}</td>
              <td className="num">{b.withdrew || <span className="muted">—</span>}</td>
              <td className="num">{b.pending || <span className="muted">—</span>}</td>
              <td className="num">
                {b.avgRating != null
                  ? <>{b.avgRating.toFixed(1)} <span className="muted">({b.rated})</span></>
                  : <span className="muted">—</span>}
              </td>
            </tr>
          ))}
          {buckets.length === 0 && <tr><td colSpan={7} className="muted">None.</td></tr>}
        </tbody>
      </table>
      {open && (
        <RoundDrilldown
          title={`${title.replace(/^By /, "")}: ${open.label}`}
          blurb={`Every completed round in this bucket — the ${open.advanced + open.lost} decided ones are what the pass rate is computed over.`}
          rows={open.rows}
          onChanged={onChanged}
          onClose={onClose}
        />
      )}
    </section>
  );
}

export default function OutcomesPanel({
  interviews,
  onChanged,
}: {
  interviews: InterviewListRow[];
  /** Patch one round back into the Interviews page's list, so an edit here
   *  re-computes every number on this tab without a refetch. */
  onChanged: (updated: Interview) => void;
}) {
  const [signals, setSignals] = useState<Record<string, PostingSignals> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One drill-down open at a time, keyed `<cut>:<bucket>` (or a bare worklist
  // id) — same one-at-a-time behaviour as the Dashboard's drill-downs.
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchPostingSignals().then(setSignals).catch((e) => setError((e as Error).message));
  }, []);

  const rounds = useMemo(() => decidedRounds(interviews), [interviews]);
  const all = useMemo(() => overall(rounds), [rounds]);
  // The two worklists behind the stat tiles. Both recompute as you edit, so a
  // round leaves the list the moment you resolve it.
  const openRounds = useMemo(() => byRecency(undecided(rounds)), [rounds]);
  const unratedRounds = useMemo(() => byRecency(unrated(rounds)), [rounds]);

  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  const close = () => setOpen(null);
  const cutKey = (cut: string) => (open?.startsWith(`${cut}:`) ? open.slice(cut.length + 1) : null);

  if (error) return <p className="error">{error}</p>;

  if (rounds.length === 0) {
    return (
      <p className="muted" style={{ marginTop: "0.9rem" }}>
        Nothing to analyse yet — this reads debriefed rounds, so it fills in as you close rounds
        out with a go/no-go on the Upcoming and Past tabs.
      </p>
    );
  }

  return (
    <section className="outcomes">
      <p className="muted small" style={{ marginTop: "0.9rem" }}>
        Every <strong>completed</strong> interview round ({all.total}), cut three ways. The pass rate is
        <strong> advanced ÷ decided</strong> — rounds you withdrew from, and ones still without a go/no-go,
        are held out of the denominator rather than counted as losses (the same convention as the
        Dashboard's stage funnel). Cancelled rounds and networking calls are excluded entirely.
      </p>

      <div className="stat-row">
        <div className="card stat">
          <div className="stat-num">{all.advanced + all.lost}</div>
          <div className="muted">decided rounds</div>
        </div>
        <div className="card stat">
          <div className="stat-num">{all.rate != null ? `${Math.round(all.rate * 100)}%` : "–"}</div>
          <div className="muted">overall pass rate</div>
        </div>
        <div
          className={`card stat${unratedRounds.length > 0 ? " clickable" : ""}${open === "unrated" ? " active" : ""}`}
          onClick={unratedRounds.length > 0 ? () => toggle("unrated") : undefined}
          title={unratedRounds.length > 0 ? `${unratedRounds.length} round(s) carry no rating — click to rate them` : undefined}
        >
          <div className="stat-num">{all.avgRating != null ? all.avgRating.toFixed(1) : "–"}</div>
          <div className="muted">
            avg self-rating
            {unratedRounds.length > 0 && <> · {unratedRounds.length} unrated</>}
          </div>
        </div>
        <div
          className={`card stat${all.pending > 0 ? " clickable stat-warn" : ""}${open === "pending" ? " active" : ""}`}
          onClick={all.pending > 0 ? () => toggle("pending") : undefined}
          title={all.pending > 0 ? "Rounds with no verdict — click to decide them" : undefined}
        >
          <div className="stat-num">{all.pending}</div>
          <div className="muted">awaiting a go/no-go</div>
        </div>
      </div>

      {open === "pending" && (
        <section className="card">
          <RoundDrilldown
            title="Awaiting a go/no-go"
            blurb="Completed rounds sitting on “hold” or carrying no decision at all — they're held out of every rate on this page, so these are the ones that make the numbers real. Rows leave this list as you decide them."
            rows={openRounds}
            onChanged={onChanged}
            onClose={close}
          />
        </section>
      )}

      {open === "unrated" && (
        <section className="card">
          <RoundDrilldown
            title="Rounds with no rating"
            blurb="The 1–5 self-rating is the “how did that actually feel” read alongside the verdict. It doesn't move the pass rate — it's the column that tells you whether a round you passed was close."
            rows={unratedRounds}
            onChanged={onChanged}
            onClose={close}
          />
        </section>
      )}

      <OutcomeTable
        title="By round type"
        blurb="In loop order. A rate that falls off a cliff at one row is the round to prepare differently."
        buckets={byRoundType(rounds)}
        openKey={cutKey("type")}
        onToggle={(k) => toggle(`type:${k}`)}
        onChanged={onChanged}
        onClose={close}
      />
      <OutcomeTable
        title="By company growth stage"
        blurb="From judge-growth's per-company classification. Tells you what kind of company's loop suits you."
        buckets={byGrowthStage(rounds, signals ?? {})}
        openKey={cutKey("growth")}
        onToggle={(k) => toggle(`growth:${k}`)}
        onChanged={onChanged}
        onClose={close}
      />
      <OutcomeTable
        title="By resume fit"
        blurb="Banded on the judge-fit score that drives 35% of the priority ranking. A flat line here means the fit score isn't predicting how the loop actually goes."
        buckets={byFitBand(rounds, signals ?? {})}
        openKey={cutKey("fit")}
        onToggle={(k) => toggle(`fit:${k}`)}
        onChanged={onChanged}
        onClose={close}
      />

      {all.pending > 0 && (
        <p className="muted small">
          {all.pending} completed round{all.pending === 1 ? " is" : "s are"} still on “hold” or carry no decision at
          all — they sit outside every rate above.{" "}
          <button className="linklike" onClick={() => setOpen("pending")}>Decide them here</button>, or work
          them from the Past tab or the Action Queue's “Decide: move forward?” card.
        </p>
      )}
    </section>
  );
}
