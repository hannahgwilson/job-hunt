// The interview-round vocabulary: one place that knows how far through a loop
// each `interviews.interview_type` sits and what to call it on screen.
//
// Three surfaces read this — the Pipeline board's column split (lib/board.ts),
// the outcome analytics (lib/outcomes.ts), and every place a round type is
// rendered — so a relabel or a new type lands in one file.

import type { Interview } from "./types";

// How far through a loop each round type sits. Higher = further along.
// Ties are deliberate: the middle rounds (technical / behavioral / system
// design) are interchangeable in ordering terms — none is "further" than
// another. 0 = unknown / not a formal round type.
export const ROUND_RANK: Record<string, number> = {
  phone_screen: 1,
  technical: 2,
  behavioral: 2,
  system_design: 2,
  hiring_manager: 3,
  team: 4,
  final: 5,
};

// Display names. `team` reads as "panel" everywhere — schema.sql's
// interview_type CHECK has no `panel` value, and relabelling the closest one
// (`team`) means the split shipped with no migration. If a real `panel` value
// is ever wanted, it's a CHECK-constraint migration plus an entry in both maps
// here; nothing else needs to move.
export const ROUND_LABELS: Record<string, string> = {
  phone_screen: "phone screen",
  technical: "technical",
  behavioral: "behavioral",
  system_design: "system design",
  hiring_manager: "hiring manager",
  team: "panel",
  final: "final",
};

/** Human label for any interview_type, including the networking ones (which
 *  aren't in the map and just get their underscores stripped). */
export function roundLabel(t: string | null | undefined): string | null {
  return t ? ROUND_LABELS[t] ?? t.replace(/_/g, " ") : null;
}

/** A round counts toward progress once it's on the books or has happened.
 *  Cancelled / no-show rounds advanced nothing, and networking calls are not
 *  rounds at all — the same predicate the SQL analytics use (D2 / T2.1). */
export function countsTowardProgress(iv: Pick<Interview, "category" | "status">): boolean {
  return iv.category === "interview" && (iv.status === "completed" || iv.status === "scheduled");
}

// ── awaiting debrief (T3.1) ─────────────────────────────────────────────────
// Still 'scheduled' but the date has passed (or there's no date at all) — a
// round that happened and was never closed out. Undated rows count too: an
// interview with no date that's still open is exactly as much of a loose end
// as an overdue one.
//
// This matters beyond tidiness: until a round is closed out it keeps counting
// as `interviews_pending` in get_stage_roles and keeps the application looking
// live in the funnel, so an un-debriefed backlog quietly distorts the metrics.
// Hence the same predicate on three surfaces — Interviews, Dashboard, and the
// Action Queue — instead of only the tab you'd have to go looking in.
export function isAwaitingDebrief(
  iv: Pick<Interview, "status" | "scheduled_at">,
  now: string = new Date().toISOString(),
): boolean {
  return iv.status === "scheduled" && (!iv.scheduled_at || iv.scheduled_at < now);
}

/** The overdue set, newest first. Networking calls are included on purpose —
 *  a coffee chat that never got logged is still a loose end, and the Interviews
 *  tab's "Needs debrief" has always listed them. */
export function awaitingDebrief<T extends Pick<Interview, "status" | "scheduled_at">>(rows: T[]): T[] {
  const now = new Date().toISOString();
  return rows
    .filter((iv) => isAwaitingDebrief(iv, now))
    .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? ""));
}
