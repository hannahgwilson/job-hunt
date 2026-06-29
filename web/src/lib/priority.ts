// Client-side mirror of compute_priority() in functions.sql — so a role page can
// show the full priority breakdown for ANY posting, including ones with a live
// application (those never appear in get_prioritized_roles / roles_to_apply,
// which is the only place the server hands back a computed priority).
//
// ⚠️ KEEP IN SYNC with functions.sql:compute_priority and
//    semantic/metrics/priority_score.yaml. Weights, scale ladders, comp band, and
//    null defaults are duplicated here on purpose — there is no single runtime
//    source for a one-off posting. If you change the algorithm in SQL, change it
//    here AND in the YAML. The values below match functions.sql (comp band
//    120k/220k, the NYC ladder, neutral 0.5 defaults).

import type { CareerTrajectory, GrowthStage, PriorityComponents } from "./types";

export const WEIGHTS: PriorityComponents = {
  experience: 0.35,
  location: 0.15,
  comp: 0.15,
  career: 0.2,
  growth: 0.15,
};

const COMP_FLOOR = 120000;
const COMP_TARGET = 220000;

// One posting's prioritization inputs — the columns compute_priority reads.
export interface PriorityInputs {
  experience_alignment: number | null;
  location: string | null;
  remote_policy: string | null;
  salary_min: number | null;
  salary_max: number | null;
  career_trajectory: CareerTrajectory | null;
  growth_stage: GrowthStage | null;
}

const CAREER_SCALE: Record<CareerTrajectory, number> = {
  step_up: 1.0,
  lateral: 0.75,
  step_back: 0.25,
};

const GROWTH_SCALE: Record<GrowthStage, number> = {
  growth: 1.0,
  early: 0.9,
  late: 0.7,
  seed: 0.65,
  public: 0.5,
  unknown: 0.5,
};

function isNyc(location: string | null): boolean {
  if (!location) return false;
  return /new york|nyc|manhattan|brooklyn/i.test(location);
}

function locationFit(location: string | null, remote: string | null): number {
  const nyc = isNyc(location);
  if (remote === "remote") return 0.85;
  if (remote === "hybrid") return nyc ? 1.0 : 0.55;
  if (remote === "onsite") return nyc ? 0.65 : 0.25;
  if (nyc) return 0.6; // NYC, policy unknown
  return 0.4; // fully unknown
}

function compFit(min: number | null, max: number | null): number {
  if (min == null && max == null) return 0.4;
  const mid = ((min ?? max)! + (max ?? min)!) / 2;
  return Math.max(0, Math.min(1, (mid - COMP_FLOOR) / (COMP_TARGET - COMP_FLOOR)));
}

// The fits, faithful to compute_priority. null inputs fall back to the same
// neutral defaults the SQL uses, so an un-enriched role isn't buried.
export function priorityComponents(p: PriorityInputs): PriorityComponents {
  return {
    experience: p.experience_alignment ?? 0.5,
    location: locationFit(p.location, p.remote_policy),
    comp: compFit(p.salary_min, p.salary_max),
    career: p.career_trajectory ? CAREER_SCALE[p.career_trajectory] : 0.5,
    growth: p.growth_stage ? GROWTH_SCALE[p.growth_stage] : 0.5,
  };
}

// Weights default to the spec constant, but a caller can pass the user's stored
// weights (get_priority_weights) so a one-off posting's breakdown matches the
// server force-ranking after the Pipeline sliders have been moved.
export function priorityScore(c: PriorityComponents, weights: PriorityComponents = WEIGHTS): number {
  const raw =
    100 *
    (weights.experience * c.experience +
      weights.location * c.location +
      weights.comp * c.comp +
      weights.career * c.career +
      weights.growth * c.growth);
  return Math.round(raw * 10) / 10;
}
