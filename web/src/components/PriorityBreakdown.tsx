import type { CareerJudgment, GrowthJudgment, PriorityComponents } from "../lib/types";
import {
  priorityComponents,
  priorityScore,
  WEIGHTS,
  type PriorityInputs,
} from "../lib/priority";

// The five inputs to the priority score, expanded — what the mini fit-bars in
// the to-apply table show, but with the raw input, weight, and points each
// component contributes spelled out. Mirrors functions.sql via lib/priority.
// Shown at the top of the role pages so "why does this rank here" is legible.
//
// When `judges` is supplied it also hosts the AI judges for the two subjective
// company/career signals (the third, experience, is the Resume-fit card below),
// each with a button and the judge's rationale inline next to its component.

function scoreClass(s: number): string {
  if (s >= 70) return "score-high";
  if (s >= 45) return "score-mid";
  return "score-low";
}

function pct(a: number): string {
  return `${Math.round(a * 100)}%`;
}

function k(n: number): string {
  return `$${Math.round(n / 1000)}k`;
}

// A human read of each component's raw input, plus whether it's still the
// neutral default (so we can nudge the user to enrich it).
function describe(
  key: keyof PriorityComponents,
  p: PriorityInputs,
): { input: string; neutral: boolean } {
  switch (key) {
    case "experience":
      return p.experience_alignment == null
        ? { input: "not judged yet", neutral: true }
        : { input: `${pct(p.experience_alignment)} fit vs resume`, neutral: false };
    case "career":
      if (p.career_trajectory == null) return { input: "not judged yet", neutral: true };
      return {
        input: { step_up: "Step up", lateral: "Lateral", step_back: "Step back" }[
          p.career_trajectory
        ],
        neutral: false,
      };
    case "growth":
      if (p.growth_stage == null) return { input: "not judged yet", neutral: true };
      return {
        input: p.growth_stage === "unknown" ? "Stage unknown" : `${p.growth_stage}-stage`,
        neutral: p.growth_stage === "unknown",
      };
    case "location": {
      const parts = [p.location, p.remote_policy].filter(Boolean);
      return { input: parts.length ? parts.join(" · ") : "location unknown", neutral: false };
    }
    case "comp":
      if (p.salary_min == null && p.salary_max == null)
        return { input: "no posted salary", neutral: true };
      if (p.salary_min && p.salary_max)
        return { input: `${k(p.salary_min)}–${k(p.salary_max)}`, neutral: false };
      return { input: k((p.salary_min ?? p.salary_max)!), neutral: false };
  }
}

const LABELS: Record<keyof PriorityComponents, string> = {
  experience: "Fit vs resume",
  career: "Career move",
  location: "Location",
  comp: "Comp",
  growth: "Company growth",
};

// Highest-weight levers first, so the inputs that move the score most read top-down.
const ORDER: Array<keyof PriorityComponents> = [
  "experience",
  "career",
  "location",
  "comp",
  "growth",
];

export interface PriorityJudges {
  career: CareerJudgment | null;
  growth: GrowthJudgment | null;
  onJudgeCareer: () => void;
  onJudgeGrowth: () => void;
  judgingCareer: boolean;
  judgingGrowth: boolean;
  error?: string | null;
}

function fmtDeltas(d: CareerJudgment["deltas"]): string {
  if (!d) return "";
  const arrow: Record<string, string> = { up: "↑", flat: "→", down: "↓", "n/a": "·" };
  return Object.entries(d)
    .map(([axis, dir]) => `${axis} ${arrow[dir] ?? dir}`)
    .join("  ");
}

function CareerJudgeBlock({ j, busy, onRun }: { j: CareerJudgment | null; busy: boolean; onRun: () => void }) {
  return (
    <div className="pb-judge">
      <div className="pb-judge-head">
        <span className="pb-judge-title">Career move</span>
        <button className="ghost sm" onClick={onRun} disabled={busy}>
          {busy ? "Judging…" : j?.trajectory ? "Re-judge" : "Judge career move"}
        </button>
      </div>
      {j?.rationale && (
        <>
          <p className="small">{j.rationale}</p>
          {j.deltas && <p className="muted small mono">{fmtDeltas(j.deltas)}</p>}
        </>
      )}
    </div>
  );
}

function GrowthJudgeBlock({ j, busy, onRun }: { j: GrowthJudgment | null; busy: boolean; onRun: () => void }) {
  const s = j?.signals;
  return (
    <div className="pb-judge">
      <div className="pb-judge-head">
        <span className="pb-judge-title">Company growth</span>
        <button className="ghost sm" onClick={onRun} disabled={busy}>
          {busy ? "Researching…" : j?.stage ? "Re-judge" : "Judge company growth"}
        </button>
      </div>
      {j?.rationale && <p className="small">{j.rationale}</p>}
      {s && (
        <ul className="pb-signals muted small">
          {s.funding_stage && <li>Stage: {s.funding_stage}{s.last_round_date ? ` (${s.last_round_date})` : ""}</li>}
          {s.total_raised && <li>Raised: {s.total_raised}</li>}
          {s.headcount && <li>Headcount: {s.headcount}{s.headcount_trend ? ` · ${s.headcount_trend}` : ""}</li>}
          {s.momentum?.length ? <li>Momentum: {s.momentum.join("; ")}</li> : null}
          {s.risks?.length ? <li>Risks: {s.risks.join("; ")}</li> : null}
        </ul>
      )}
      {j?.sources && j.sources.length > 0 && (
        <p className="muted small">
          Sources: {j.sources.slice(0, 4).map((u, i) => (
            <span key={i}>
              {i > 0 ? ", " : ""}
              <a href={u} target="_blank" rel="noreferrer">{i + 1}</a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export default function PriorityBreakdown({
  inputs,
  judges,
}: {
  inputs: PriorityInputs;
  judges?: PriorityJudges;
}) {
  const components = priorityComponents(inputs);
  const score = priorityScore(components);
  const anyNeutral = ORDER.some((k) => describe(k, inputs).neutral);

  return (
    <section className="card priority-breakdown">
      <div className="section-head">
        <h2>Priority breakdown</h2>
        <span className={`score-badge ${scoreClass(score)}`}>{score}</span>
      </div>

      <div className="pb-rows">
        {ORDER.map((key) => {
          const fit = components[key];
          const weight = WEIGHTS[key];
          const points = fit * weight * 100;
          const { input, neutral } = describe(key, inputs);
          return (
            <div className="pb-row" key={key}>
              <div className="pb-label">
                {LABELS[key]}
                <span className="pb-weight">×{weight}</span>
              </div>
              <div className={`pb-input${neutral ? " muted" : ""}`}>{input}</div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${fit * 100}%` }} />
              </div>
              <div className="pb-points">+{points.toFixed(1)}</div>
            </div>
          );
        })}
      </div>

      {anyNeutral && !judges && (
        <p className="muted small">
          Components marked “not judged” use the neutral 0.5 default — run the AI
          judges to score them for real.
        </p>
      )}

      {judges && (
        <div className="pb-judges">
          {judges.error && <p className="error">{judges.error}</p>}
          <CareerJudgeBlock j={judges.career} busy={judges.judgingCareer} onRun={judges.onJudgeCareer} />
          <GrowthJudgeBlock j={judges.growth} busy={judges.judgingGrowth} onRun={judges.onJudgeGrowth} />
        </div>
      )}
    </section>
  );
}
