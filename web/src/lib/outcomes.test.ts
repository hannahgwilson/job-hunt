import { describe, expect, it } from "vitest";
import { byFitBand, byGrowthStage, byRoundType, decidedRounds, overall, type PostingSignals } from "./outcomes";
import { awaitingDebrief, isAwaitingDebrief } from "./rounds";
import type { AdvanceDecision, InterviewListRow } from "./types";

// The rate convention is the whole point of this module — withdraw and hold are
// held OUT of the denominator rather than counted as losses (see
// semantic/metrics/round_pass_rate.yaml). Easy to get subtly wrong, invisible
// when it is, so it's pinned here.

let n = 0;
const iv = (over: Partial<InterviewListRow> = {}): InterviewListRow => ({
  id: `iv-${n++}`,
  interview_type: "phone_screen",
  category: "interview",
  scheduled_at: "2026-07-01T12:00:00Z",
  status: "completed",
  notes: null,
  rating: null,
  feedback: null,
  advance_decision: null,
  decision_notes: null,
  application_id: "app-1",
  job_posting_id: "post-1",
  role_title: "A role",
  organization_id: "org-1",
  organization_name: "A company",
  contact_name: null,
  ...over,
});

const withDecision = (d: AdvanceDecision | null, over: Partial<InterviewListRow> = {}) =>
  iv({ advance_decision: d, ...over });

describe("decidedRounds", () => {
  it("keeps only completed formal rounds", () => {
    const rows = [
      iv(),                                        // completed interview — in
      iv({ status: "scheduled" }),                 // hasn't happened
      iv({ status: "cancelled" }),                 // decided nothing
      iv({ status: "no_show" }),                   // decided nothing
      iv({ category: "networking" }),              // not a round (D2 / T2.1)
    ];
    expect(decidedRounds(rows)).toHaveLength(1);
  });
});

describe("the pass-rate convention", () => {
  it("counts advance over advance + rejected, holding withdraw and hold aside", () => {
    const b = overall([
      withDecision("advance"),
      withDecision("advance"),
      withDecision("rejected"),
      withDecision("withdraw"),
      withDecision("hold"),
      withDecision(null),
    ]);
    expect(b.advanced).toBe(2);
    expect(b.lost).toBe(1);
    expect(b.withdrew).toBe(1);
    expect(b.pending).toBe(2);      // 'hold' and the un-decided one
    expect(b.rate).toBeCloseTo(2 / 3);
    expect(b.total).toBe(6);
  });

  it("is null rather than 0 when nothing has been decided", () => {
    expect(overall([withDecision("hold"), withDecision("withdraw")]).rate).toBeNull();
  });

  it("averages only the rounds that carry a rating", () => {
    const b = overall([iv({ rating: 5 }), iv({ rating: 3 }), iv({ rating: null })]);
    expect(b.avgRating).toBe(4);
    expect(b.rated).toBe(2);
  });
});

describe("byRoundType", () => {
  it("orders buckets by loop position and labels team as panel", () => {
    const rows = [
      iv({ interview_type: "final" }),
      iv({ interview_type: "phone_screen" }),
      iv({ interview_type: "team" }),
      iv({ interview_type: "hiring_manager" }),
    ];
    expect(byRoundType(rows).map((b) => b.label))
      .toEqual(["phone screen", "hiring manager", "panel", "final"]);
  });

  it("surfaces untyped rounds first rather than hiding them", () => {
    const rows = [iv({ interview_type: "final" }), iv({ interview_type: null })];
    expect(byRoundType(rows)[0].label).toBe("untyped");
  });
});

describe("the dimensional cuts", () => {
  const signals: Record<string, PostingSignals> = {
    "post-a": { experience_alignment: 0.9, growth_stage: "growth" },
    "post-b": { experience_alignment: 0.5, growth_stage: "public" },
    "post-c": { experience_alignment: null, growth_stage: null },
  };

  it("buckets by growth stage, with an explicit bucket for unjudged companies", () => {
    const rows = [
      iv({ job_posting_id: "post-a" }),
      iv({ job_posting_id: "post-b" }),
      iv({ job_posting_id: "post-c" }),
      iv({ job_posting_id: "post-unknown" }),   // no signals row at all
    ];
    const got = Object.fromEntries(byGrowthStage(rows, signals).map((b) => [b.label, b.total]));
    expect(got).toEqual({ growth: 1, public: 1, "not judged": 2 });
  });

  it("bands by fit score, keeping unscored postings visible", () => {
    const rows = [
      iv({ job_posting_id: "post-a" }),   // 0.9  -> excellent
      iv({ job_posting_id: "post-b" }),   // 0.5  -> weak
      iv({ job_posting_id: "post-c" }),   // null -> not scored
    ];
    expect(byFitBand(rows, signals).map((b) => b.label))
      .toEqual(["excellent fit (85%+)", "weak fit (<60%)", "not scored"]);
  });
});

describe("awaitingDebrief", () => {
  const NOW = "2026-07-15T00:00:00Z";

  it("catches past-dated rounds still sitting on scheduled", () => {
    expect(isAwaitingDebrief({ status: "scheduled", scheduled_at: "2026-07-01T12:00:00Z" }, NOW)).toBe(true);
  });

  it("catches undated open rounds — as much of a loose end as an overdue one", () => {
    expect(isAwaitingDebrief({ status: "scheduled", scheduled_at: null }, NOW)).toBe(true);
  });

  it("leaves future rounds and closed-out ones alone", () => {
    expect(isAwaitingDebrief({ status: "scheduled", scheduled_at: "2026-07-20T12:00:00Z" }, NOW)).toBe(false);
    expect(isAwaitingDebrief({ status: "completed", scheduled_at: "2026-07-01T12:00:00Z" }, NOW)).toBe(false);
    expect(isAwaitingDebrief({ status: "cancelled", scheduled_at: "2026-07-01T12:00:00Z" }, NOW)).toBe(false);
  });

  it("sorts newest first", () => {
    const rows = [
      iv({ status: "scheduled", scheduled_at: "2020-01-01T00:00:00Z" }),
      iv({ status: "scheduled", scheduled_at: "2020-06-01T00:00:00Z" }),
    ];
    expect(awaitingDebrief(rows).map((r) => r.scheduled_at))
      .toEqual(["2020-06-01T00:00:00Z", "2020-01-01T00:00:00Z"]);
  });
});
