import { describe, expect, it } from "vitest";
import { boardColumnFor, furthestRound } from "./board";
import type { Application, ApplicationStatus, Interview } from "./types";

// The board's bucketing is the only derived thing on the Pipeline (T3.3), and
// the interesting cases (a round scheduled out of loop order, cancelled rounds,
// networking calls, an app with no rounds at all) are exactly the ones that are
// tedious to reproduce by hand in the app.

type Round = NonNullable<Application["interviews"]>[number];

const round = (
  interview_type: string | null,
  status: Interview["status"] = "completed",
  scheduled_at = "2026-07-01T12:00:00Z",
  category: Interview["category"] = "interview",
): Round => ({ interview_type, category, status, scheduled_at });

const app = (status: ApplicationStatus, interviews?: Round[]): Application => ({
  id: "a1", status, applied_date: null, response_date: null, notes: null, interviews,
});

describe("furthestRound", () => {
  it("ranks by loop position, not by date", () => {
    // A follow-up technical scheduled AFTER the final round must not drag the
    // card backwards — this is where the board deliberately diverges from
    // get_stage_roles.furthest_round, which takes the latest by date.
    const a = app("interviewing", [
      round("final", "completed", "2026-07-01T12:00:00Z"),
      round("technical", "scheduled", "2026-07-20T12:00:00Z"),
    ]);
    expect(furthestRound(a)).toBe("final");
  });

  it("counts scheduled rounds, not just completed ones", () => {
    expect(furthestRound(app("interviewing", [round("team", "scheduled")]))).toBe("team");
  });

  it("ignores cancelled and no-show rounds", () => {
    const a = app("interviewing", [
      round("hiring_manager", "completed"),
      round("final", "cancelled"),
      round("team", "no_show"),
    ]);
    expect(furthestRound(a)).toBe("hiring_manager");
  });

  it("ignores networking calls (D2 / T2.1)", () => {
    const a = app("interviewing", [
      round("phone_screen"),
      round("coffee_chat", "completed", "2026-07-05T12:00:00Z", "networking"),
    ]);
    expect(furthestRound(a)).toBe("phone_screen");
  });

  it("is null when there are no rounds, or none is typed", () => {
    expect(furthestRound(app("interviewing"))).toBeNull();
    expect(furthestRound(app("interviewing", []))).toBeNull();
    expect(furthestRound(app("interviewing", [round(null)]))).toBeNull();
  });
});

describe("boardColumnFor", () => {
  it("maps non-interviewing statuses straight across", () => {
    expect(boardColumnFor(app("applied"))).toBe("applied");
    expect(boardColumnFor(app("screening"))).toBe("screening");
    expect(boardColumnFor(app("offer"))).toBe("offer");
  });

  it("keeps terminal statuses off the board entirely", () => {
    // accepted comes off the board deliberately (T3.3); rejected/withdrawn/
    // closed already did. All four render in sections below it instead.
    for (const s of ["accepted", "rejected", "withdrawn", "closed", "draft"] as ApplicationStatus[]) {
      expect(boardColumnFor(app(s))).toBeNull();
    }
  });

  it("splits interviewing by furthest round", () => {
    expect(boardColumnFor(app("interviewing", [round("hiring_manager")]))).toBe("interviewing_hiring_manager");
    expect(boardColumnFor(app("interviewing", [round("team")]))).toBe("interviewing_panel");
    expect(boardColumnFor(app("interviewing", [round("final")]))).toBe("interviewing_final");
  });

  it("falls back to the generic column for early rounds and for no rounds at all", () => {
    // Not dropped: an interviewing app with nothing logged is still in the
    // pipeline, and the card says "no rounds logged" so it's actionable.
    expect(boardColumnFor(app("interviewing"))).toBe("interviewing");
    expect(boardColumnFor(app("interviewing", [round("phone_screen")]))).toBe("interviewing");
    expect(boardColumnFor(app("interviewing", [round("technical"), round("behavioral")]))).toBe("interviewing");
  });
});
