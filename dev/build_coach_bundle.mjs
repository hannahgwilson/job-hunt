#!/usr/bin/env node
/**
 * build_coach_bundle — compile the interview-coach skill's references into a
 * TS module the interview-prep edge function can import.
 *
 *   node dev/build_coach_bundle.mjs            # write the bundle
 *   node dev/build_coach_bundle.mjs --check    # fail if the bundle is stale
 *
 * The skill repo (github.com/noamseg/interview-coach-skill) stays the source of
 * truth; this repo commits the generated bundle so the edge function has no
 * runtime dependency on a sibling checkout. Point at the skill with
 * COACH_SKILL_DIR, defaulting to ../interview-coach-skill.
 *
 * Why sections and not files: references/ is ~675KB and one command file runs to
 * 42KB — dumping whole files into a prompt would cost more than the answer is
 * worth. Each MANIFEST entry names a heading; only that heading's section is
 * extracted, and stages compose a handful of fragments each. A missing heading
 * is a hard error, so upstream edits surface here instead of silently emptying
 * a prompt.
 *
 * See docs/interview-coach-integration.md.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = resolve(process.env.COACH_SKILL_DIR ?? join(REPO, "..", "interview-coach-skill"));
const OUT = join(REPO, "supabase", "functions", "interview-prep", "coach-bundle.ts");

/**
 * name -> the slices that make it up. `file` is relative to the skill repo;
 * `headings` are matched exactly against a markdown heading line (any level),
 * and the slice runs to the next heading of the same or higher level.
 */
const MANIFEST = {
  rubric_dimensions: {
    file: "references/rubrics-detailed.md",
    headings: [
      "Substance (Evidence Quality)",
      "Structure (Narrative Clarity)",
      "Relevance (Question Fit)",
      "Credibility (Believability)",
      "Differentiation (Uniqueness)",
    ],
  },
  rubric_seniority: {
    file: "references/rubrics-detailed.md",
    headings: ["Seniority Calibration", "Aggregate Scoring"],
  },
  rubric_root_cause: {
    file: "references/rubrics-detailed.md",
    headings: ["Root Cause Taxonomy (Cross-Dimensional)"],
  },
  voice_directness: {
    file: "references/coaching-voice.md",
    headings: ["Feedback Directness Modulation"],
  },
  voice_failure_modes: {
    file: "references/coaching-voice.md",
    headings: ["Coaching Failure Mode Awareness"],
  },
  differentiation_fires: {
    file: "references/differentiation.md",
    headings: ["When Differentiation Coaching Fires"],
  },
  differentiation_secrets: {
    file: "references/differentiation.md",
    headings: ["Earned Secrets"],
  },
  differentiation_pov: {
    file: "references/differentiation.md",
    headings: ["Spiky POV Polish"],
  },
  storybank_format: {
    file: "references/storybank-guide.md",
    headings: ["Storybank Format"],
  },
  storybank_selection: {
    file: "references/storybank-guide.md",
    headings: ["Story Selection Strategy"],
  },
  storybank_health: {
    file: "references/storybank-guide.md",
    headings: ["Quick Reference: Storybank Health Check"],
  },
  calibration_drift: {
    file: "references/calibration-engine.md",
    headings: ["Section 2: Scoring Drift Detection Protocol"],
  },
  calibration_root_cause: {
    file: "references/calibration-engine.md",
    headings: ["Section 3: Cross-Dimension Root Cause Tracking"],
  },
  challenge_lenses: {
    file: "references/challenge-protocol.md",
    headings: ["The Five Lenses"],
  },
  challenge_avoidance: {
    file: "references/challenge-protocol.md",
    headings: ["Avoidance Confrontation Protocol"],
  },
  evidence_sourcing: {
    file: "references/evidence-sourcing.md",
    headings: ["How to source evidence naturally", "Rules"],
  },
  gap_handling: {
    file: "references/cross-cutting.md",
    headings: ["Gap-Handling Module"],
  },
  signal_reading: {
    file: "references/cross-cutting.md",
    headings: ["Signal-Reading Module"],
  },
  psych_readiness: {
    file: "references/cross-cutting.md",
    headings: ["Psychological Readiness Module"],
  },
  cultural_awareness: {
    file: "references/cross-cutting.md",
    headings: ["Cultural and Linguistic Awareness Module"],
  },
  role_fit: {
    file: "references/cross-cutting.md",
    headings: ["Role-Fit Assessment Module"],
  },
  cmd_concerns: {
    file: "references/commands/concerns.md",
    headings: ["Sequence", "Concern Tracking"],
  },
  cmd_questions: {
    file: "references/commands/questions.md",
    headings: ["Stage Adaptation", "Questions To Avoid"],
  },
  cmd_hype: {
    file: "references/commands/hype.md",
    headings: ["Data-Driven Hype", "Anxiety-Profile Personalization", "Interview-Specific Tailoring"],
  },
  cmd_progress: {
    file: "references/commands/progress.md",
    headings: ["Trend Narration", "Self-Assessment Calibration", "Graduation Criteria"],
  },
  cmd_decode: {
    file: "references/commands/decode.md",
    headings: ["How JDs Actually Work (Reference Knowledge)", "Confidence Labeling System"],
  },
  cmd_mock: {
    file: "references/commands/mock.md",
    headings: ["Execution", "Panel Simulation UX"],
  },
  cmd_stories: {
    file: "references/commands/stories.md",
    headings: ["Story Strength Audit", "Common Behavioral Story Categories"],
  },
};

/** Which fragments each edge-function stage gets, in prompt order. */
const STAGES = {
  research: ["role_fit"],
  chat_reply: ["cmd_mock", "signal_reading", "gap_handling"],
  feedback: [
    "rubric_dimensions",
    "rubric_seniority",
    "rubric_root_cause",
    "differentiation_fires",
    "evidence_sourcing",
    "voice_directness",
    "cultural_awareness",
  ],
  feedback_challenge: ["challenge_lenses", "challenge_avoidance"],
  synthesize: ["storybank_format", "storybank_selection", "differentiation_secrets", "rubric_seniority"],
  concerns: ["cmd_concerns", "gap_handling", "role_fit"],
  questions: ["cmd_questions"],
  hype: ["cmd_hype", "psych_readiness"],
  progress: ["cmd_progress", "calibration_drift", "calibration_root_cause", "voice_failure_modes"],
  decode: ["cmd_decode", "role_fit", "storybank_selection"],
  stories: ["storybank_format", "storybank_health", "cmd_stories", "differentiation_secrets"],
};

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** Extract one heading's section — the heading line through to the next heading of the same or higher level. */
function slice(markdown, wanted, file) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => {
    const m = l.match(HEADING);
    return m && m[2] === wanted;
  });
  if (start === -1) {
    throw new Error(
      `heading "${wanted}" not found in ${file} — the skill repo moved or renamed it. ` +
        `Update MANIFEST in dev/build_coach_bundle.mjs.`,
    );
  }
  const level = lines[start].match(HEADING)[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(HEADING);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

function main() {
  if (!existsSync(SKILL_DIR)) {
    console.error(
      `coach skill not found at ${SKILL_DIR}\n` +
        `Clone it beside this repo, or set COACH_SKILL_DIR=/path/to/interview-coach-skill.`,
    );
    process.exit(1);
  }

  const digest = createHash("sha256");
  const cache = new Map();
  const fragments = {};

  for (const [name, { file, headings }] of Object.entries(MANIFEST)) {
    if (!cache.has(file)) {
      const path = join(SKILL_DIR, file);
      if (!existsSync(path)) throw new Error(`${file} missing from ${SKILL_DIR}`);
      const text = readFileSync(path, "utf8");
      cache.set(file, text);
      digest.update(`${file}\0${text}\0`);
    }
    fragments[name] = headings.map((h) => slice(cache.get(file), h, file)).join("\n\n");
  }

  for (const [stage, names] of Object.entries(STAGES)) {
    const missing = names.filter((n) => !(n in fragments));
    if (missing.length) throw new Error(`stage "${stage}" references unknown fragment(s): ${missing.join(", ")}`);
  }

  const sourceDigest = digest.digest("hex").slice(0, 16);
  const body = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Compiled from the interview-coach skill's references/ by
 * dev/build_coach_bundle.mjs. To change what the coach knows, edit the skill
 * repo (or the MANIFEST in that script) and re-run it.
 *
 * See docs/interview-coach-integration.md.
 */

/** sha256 (truncated) of every source file that fed this bundle. */
export const SOURCE_DIGEST = ${JSON.stringify(sourceDigest)};

export const FRAGMENTS: Record<string, string> = {
${Object.entries(fragments).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join("\n")}
};

export type CoachStage = ${Object.keys(STAGES).map((s) => JSON.stringify(s)).join(" | ")};

const STAGE_FRAGMENTS: Record<CoachStage, string[]> = {
${Object.entries(STAGES).map(([k, v]) => `  ${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}],`).join("\n")}
};

/**
 * The coaching guidance for one stage, ready to drop into a system prompt.
 * Pass extra fragment names to append (e.g. "challenge_lenses" at directness 5).
 */
export function coachGuidance(stage: CoachStage, extra: string[] = []): string {
  return [...STAGE_FRAGMENTS[stage], ...extra]
    .map((name) => FRAGMENTS[name])
    .filter(Boolean)
    .join("\\n\\n---\\n\\n");
}
`;

  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== body) {
      console.error("coach-bundle.ts is stale — run: node dev/build_coach_bundle.mjs");
      process.exit(1);
    }
    console.log(`coach-bundle.ts is current (digest ${sourceDigest})`);
    return;
  }

  writeFileSync(OUT, body);

  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`wrote ${OUT}`);
  console.log(`  source digest ${sourceDigest}, ${cache.size} files, ${Object.keys(fragments).length} fragments`);
  console.log("\n  stage prompt budgets:");
  for (const [stage, names] of Object.entries(STAGES)) {
    const size = names.reduce((n, name) => n + fragments[name].length, 0);
    console.log(`    ${stage.padEnd(18)} ${kb(size).padStart(8)}  ${names.join(", ")}`);
  }
}

main();
