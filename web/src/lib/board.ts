// The Pipeline kanban's column model (T3.3).
//
// The board used to be a 1:1 render of `applications.status` — one column per
// enum value. That conflated every interview round into one "interviewing"
// column, which is where most of the pipeline actually lives. This module adds
// the second axis: `interviewing` apps are split by how far through the loop
// they are, derived from their own interview rounds.
//
// Deliberately NOT a status-enum change. `applications.status` still has
// exactly one `interviewing` value, so the funnel metrics, the status-history
// trigger, STATUS_ORDER and every SQL function are untouched — the split lives
// only in how the board groups cards.

import type { Application, ApplicationStatus } from "./types";
import { ROUND_RANK, countsTowardProgress } from "./rounds";

// The furthest round an application has reached, by ROUND_RANK.
//
// NOTE — this deliberately differs from `get_stage_roles.furthest_round`, which
// takes the chronologically *last* round instead. Both are defensible: the
// drill-down column answers "what was the most recent round", the board answers
// "how far along is this". Date-ordering on a board reads as a bug — scheduling
// a follow-up technical after a final round would drag the card backwards — so
// the board ranks. If these two should agree, the SQL is the one to change.
export function furthestRound(app: Application): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const iv of app.interviews ?? []) {
    if (!countsTowardProgress(iv) || !iv.interview_type) continue;
    const rank = ROUND_RANK[iv.interview_type] ?? 0;
    if (rank > bestRank) { bestRank = rank; best = iv.interview_type; }
  }
  return best;
}

// A board column key. The three `interviewing_*` keys are derived — no such
// application status exists.
export type BoardColumnKey =
  | "applied" | "screening"
  | "interviewing" | "interviewing_hiring_manager" | "interviewing_panel" | "interviewing_final"
  | "offer";

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  /** The application status this column draws from. */
  status: ApplicationStatus;
  /** Existing `pill-*` class — the three interviewing buckets share one so they read as one stage. */
  pill: string;
  /** Shown under the header on the derived columns, so the split isn't mysterious. */
  hint?: string;
}

// The forward funnel, left to right. `accepted` is deliberately absent (T3.3):
// it's a terminal success, not a stage you work, and it cost a column's width.
// Accepted applications land in Pipeline's "Accepted offers" section instead —
// the same treatment rejected/withdrawn apps and closed roles already get.
export const BOARD_COLUMNS: BoardColumn[] = [
  { key: "applied", label: "applied", status: "applied", pill: "pill-applied" },
  { key: "screening", label: "screening", status: "screening", pill: "pill-screening" },
  { key: "interviewing", label: "interviewing", status: "interviewing", pill: "pill-interviewing",
    hint: "early rounds" },
  { key: "interviewing_hiring_manager", label: "hiring manager", status: "interviewing", pill: "pill-interviewing" },
  { key: "interviewing_panel", label: "panel", status: "interviewing", pill: "pill-interviewing" },
  { key: "interviewing_final", label: "final", status: "interviewing", pill: "pill-interviewing" },
  { key: "offer", label: "offer", status: "offer", pill: "pill-offer" },
];

// Which column a card belongs in. Non-interviewing statuses map straight
// across; interviewing apps are bucketed by their furthest round, with anything
// earlier than the hiring manager (and anything with no round logged at all)
// falling into the generic "interviewing" column rather than being dropped.
export function boardColumnFor(app: Application): BoardColumnKey | null {
  if (app.status !== "interviewing") {
    return BOARD_COLUMNS.some((c) => c.key === app.status) ? (app.status as BoardColumnKey) : null;
  }
  switch (furthestRound(app)) {
    case "final": return "interviewing_final";
    case "team": return "interviewing_panel";
    case "hiring_manager": return "interviewing_hiring_manager";
    default: return "interviewing";
  }
}
