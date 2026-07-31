// Outcome analytics (T3.2) — "which rounds do I actually lose at?"
//
// T1.2 turned `advance_decision` from a decorative pill into a signal that
// drives the application cascade. That makes debriefed rounds a real dataset:
// every closed-out round carries a verdict and (usually) a rating. Nothing
// computed anything from it until now.
//
// The rate follows pass_through_rate.yaml's convention deliberately — decided
// outcomes only, pending kept aside — so the two numbers on the Dashboard and
// this tab can be read against each other without a mental conversion:
//
//   advanced        they moved me forward         → numerator
//   lost            they passed  ('rejected')     → denominator
//   withdrew        I pulled out ('withdraw')     → set aside; my call, not a verdict
//   pending         'hold' or no decision yet     → set aside
//   rate            advanced / (advanced + lost)
//
// Computed client-side rather than in SQL: every input is already on the page
// (fetchInterviews + a thin posting-signals read), and the shape is still
// settling. See semantic/metrics/round_pass_rate.yaml — if this becomes a
// question worth asking in chat, it wants promoting to a SQL function + an MCP
// tool, and that file is where the definition already lives.

import { ROUND_RANK, roundLabel } from "./rounds";
import type { GrowthStage, InterviewListRow } from "./types";

/** Per-posting signals the round rows don't carry. Keyed by job_posting_id. */
export interface PostingSignals {
  experience_alignment: number | null;
  growth_stage: GrowthStage | null;
}

export interface OutcomeBucket {
  key: string;
  label: string;
  advanced: number;
  lost: number;
  withdrew: number;
  pending: number;
  /** advanced / (advanced + lost); null until something has been decided. */
  rate: number | null;
  /** Mean of the 1–5 ratings given, over `rated` rounds. */
  avgRating: number | null;
  rated: number;
  /** advanced + lost + withdrew + pending — every debriefed round in the bucket. */
  total: number;
}

/** Only formal rounds that actually happened. Cancelled / no-show rounds
 *  decided nothing, and networking calls aren't rounds (D2 / T2.1). */
export function decidedRounds(rows: InterviewListRow[]): InterviewListRow[] {
  return rows.filter((iv) => iv.category === "interview" && iv.status === "completed");
}

function tally(rows: InterviewListRow[], key: string, label: string): OutcomeBucket {
  let advanced = 0, lost = 0, withdrew = 0, pending = 0, ratingSum = 0, rated = 0;
  for (const iv of rows) {
    switch (iv.advance_decision) {
      case "advance": advanced++; break;
      case "rejected": lost++; break;
      case "withdraw": withdrew++; break;
      default: pending++; break;   // 'hold' or never recorded
    }
    if (iv.rating != null) { ratingSum += iv.rating; rated++; }
  }
  const decided = advanced + lost;
  return {
    key, label, advanced, lost, withdrew, pending,
    rate: decided > 0 ? advanced / decided : null,
    avgRating: rated > 0 ? ratingSum / rated : null,
    rated,
    total: rows.length,
  };
}

function group(
  rows: InterviewListRow[],
  keyOf: (iv: InterviewListRow) => string,
  labelOf: (key: string) => string,
  sort: (a: OutcomeBucket, b: OutcomeBucket) => number,
): OutcomeBucket[] {
  const byKey = new Map<string, InterviewListRow[]>();
  for (const iv of rows) {
    const k = keyOf(iv);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(iv);
  }
  return [...byKey.entries()].map(([k, rs]) => tally(rs, k, labelOf(k))).sort(sort);
}

const UNTYPED = "__untyped";

/** Pass rate by round type, in loop order — the headline cut. */
export function byRoundType(rows: InterviewListRow[]): OutcomeBucket[] {
  return group(
    rows,
    (iv) => iv.interview_type ?? UNTYPED,
    (k) => (k === UNTYPED ? "untyped" : roundLabel(k)!),
    // Loop order, so the table reads like the funnel. Untyped rounds (rank 0)
    // sort to the front — they're the ones worth going back and typing.
    (a, b) => (ROUND_RANK[a.key] ?? 0) - (ROUND_RANK[b.key] ?? 0) || a.label.localeCompare(b.label),
  );
}

const GROWTH_ORDER: string[] = ["seed", "early", "growth", "late", "public", "unknown", "__unjudged"];

/** Pass rate by the company's growth stage — do I do better at earlier-stage cos? */
export function byGrowthStage(
  rows: InterviewListRow[],
  signals: Record<string, PostingSignals>,
): OutcomeBucket[] {
  return group(
    rows,
    (iv) => (iv.job_posting_id ? signals[iv.job_posting_id]?.growth_stage ?? "__unjudged" : "__unjudged"),
    (k) => (k === "__unjudged" ? "not judged" : k),
    (a, b) => GROWTH_ORDER.indexOf(a.key) - GROWTH_ORDER.indexOf(b.key),
  );
}

// Fit bands over `experience_alignment` (0..1) — the judge-fit score that also
// drives 35% of the priority score. Four bands, because two is uninformative
// and eight would put one round in each.
const FIT_BANDS: { key: string; label: string; min: number }[] = [
  { key: "excellent", label: "excellent fit (85%+)", min: 0.85 },
  { key: "strong", label: "strong fit (75–85%)", min: 0.75 },
  { key: "moderate", label: "moderate fit (60–75%)", min: 0.6 },
  { key: "weak", label: "weak fit (<60%)", min: 0 },
];
const FIT_ORDER = [...FIT_BANDS.map((b) => b.key), "__unscored"];

function fitBand(alignment: number | null | undefined): string {
  if (alignment == null) return "__unscored";
  return FIT_BANDS.find((b) => alignment >= b.min)!.key;
}

/** Pass rate by resume-fit band — does the fit score actually predict outcomes?
 *  (The most interesting read here is a flat line: that would mean the judge's
 *  score isn't telling you anything about how the loop goes.) */
export function byFitBand(
  rows: InterviewListRow[],
  signals: Record<string, PostingSignals>,
): OutcomeBucket[] {
  return group(
    rows,
    (iv) => fitBand(iv.job_posting_id ? signals[iv.job_posting_id]?.experience_alignment : null),
    (k) => (k === "__unscored" ? "not scored" : FIT_BANDS.find((b) => b.key === k)!.label),
    (a, b) => FIT_ORDER.indexOf(a.key) - FIT_ORDER.indexOf(b.key),
  );
}

/** The all-up row, for the header line above the cuts. */
export function overall(rows: InterviewListRow[]): OutcomeBucket {
  return tally(rows, "__all", "all rounds");
}
