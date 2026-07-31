import { useEffect, useMemo, useState } from "react";
import { fetchPostingSignals } from "../lib/api";
import {
  byFitBand, byGrowthStage, byRoundType, decidedRounds, overall,
  type OutcomeBucket, type PostingSignals,
} from "../lib/outcomes";
import type { InterviewListRow } from "../lib/types";

// Interviews → Outcomes (T3.2). "Which round types do I actually lose at?" —
// the most useful thing the debrief data can tell you, and nothing computed it
// until advance_decision started meaning something (T1.2).
//
// Three cuts over the same population of debriefed rounds. The rate convention
// matches the Dashboard's stage funnel (decided outcomes only, pending set
// aside) — see lib/outcomes.ts and semantic/metrics/round_pass_rate.yaml.

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

function OutcomeTable({ title, blurb, buckets }: { title: string; blurb: string; buckets: OutcomeBucket[] }) {
  return (
    <section className="card outcome-cut">
      <h3>{title}</h3>
      <p className="muted small">{blurb}</p>
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
            <tr key={b.key}>
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
    </section>
  );
}

export default function OutcomesPanel({ interviews }: { interviews: InterviewListRow[] }) {
  const [signals, setSignals] = useState<Record<string, PostingSignals> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPostingSignals().then(setSignals).catch((e) => setError((e as Error).message));
  }, []);

  const rounds = useMemo(() => decidedRounds(interviews), [interviews]);
  const all = useMemo(() => overall(rounds), [rounds]);

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
        <div className="card stat">
          <div className="stat-num">{all.avgRating != null ? all.avgRating.toFixed(1) : "–"}</div>
          <div className="muted">avg self-rating</div>
        </div>
        <div className="card stat">
          <div className="stat-num">{all.pending}</div>
          <div className="muted">awaiting a go/no-go</div>
        </div>
      </div>

      <OutcomeTable
        title="By round type"
        blurb="In loop order. A rate that falls off a cliff at one row is the round to prepare differently."
        buckets={byRoundType(rounds)}
      />
      <OutcomeTable
        title="By company growth stage"
        blurb="From judge-growth's per-company classification. Tells you what kind of company's loop suits you."
        buckets={byGrowthStage(rounds, signals ?? {})}
      />
      <OutcomeTable
        title="By resume fit"
        blurb="Banded on the judge-fit score that drives 35% of the priority ranking. A flat line here means the fit score isn't predicting how the loop actually goes."
        buckets={byFitBand(rounds, signals ?? {})}
      />

      {all.pending > 0 && (
        <p className="muted small">
          {all.pending} completed round{all.pending === 1 ? " is" : "s are"} still on “hold” or carry no decision at
          all — they sit outside every rate above. Resolving them (Past tab, or the Action Queue's
          “Decide: move forward?” card) is what makes these numbers real.
        </p>
      )}
    </section>
  );
}
