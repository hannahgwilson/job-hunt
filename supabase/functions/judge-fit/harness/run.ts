/**
 * Three-resume validation harness for the judge-fit scoring prompt.
 *
 * Procedure from /resume-scoring-prompt-instructions.md: score three resume
 * variants (base / IC-optimized / manager-optimized) against ONE target JD,
 * collect the per-requirement adjacency table for each, and check the red flags:
 *   - a real Gap (MLOps here) stays Gap on ALL three variants (wording can't lift it)
 *   - adjacency works, not literal keyword matching (Looker→Tableau, BigQuery→
 *     Snowflake, GCP→AWS earn credit instead of scoring 0)
 *   - hands-on orchestration with no hands-on evidence ("familiar with Airflow")
 *     is Aware, not Adjacent (R5/R7)
 *   - the IC and manager resumes DIFFERENTIATE on the leadership requirement
 *
 * It imports the REAL prompt from ../prompt.ts, so it validates exactly what the
 * deployed function sends — no drift.
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...        # not stored locally; from Supabase secrets
 *   export JUDGE_MODEL=claude-sonnet-4-6       # optional; matches the function default
 *   deno run --allow-env --allow-net --allow-read \
 *     supabase/functions/judge-fit/harness/run.ts
 */

import { buildFitMessages, buildFitSystem, FIT_TOOL, type FitResult, jdContext } from "../prompt.ts";

const MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

// The single target JD: a hybrid "lead" role so the IC vs manager differentiation
// is testable, with tools chosen to exercise each adjacency rule against the
// fixtures (which carry Looker / BigQuery / GCP / dbt-Cloud, "familiar with"
// Airflow, ML-consumption only — and NO MLOps).
const POSTING = {
  title: "Analytics Engineering Lead",
  location: "New York, NY",
  remote_policy: "hybrid",
  salary_min: 180000,
  salary_max: 220000,
  requirements: [
    "Own the transformation layer in dbt on Snowflake",
    "Build executive and self-serve dashboards in Tableau",
    "Author and operate production Airflow DAGs (you write and schedule the jobs)",
    "Run the data platform on AWS (S3, Redshift, Glue)",
    "Lead, mentor, and grow a small analytics-engineering team and own its roadmap",
    "Stand up and operate MLOps in production: model serving, a feature store, and experiment tracking",
  ],
  nice_to_haves: [
    "Python for data tooling",
    "Experience with a semantic / metrics layer",
  ],
  notes:
    "A player-coach lead: you set technical direction and grow a small team, and " +
    "you are still hands-on in the stack day to day.",
};

// Which requirement each red-flag check targets, matched by substring on the
// model's requirement text (it paraphrases, so we match loosely).
const TIER_RANK: Record<string, number> = { gap: 0, aware: 1, adjacent: 2, identical: 3 };

function findReq(fit: FitResult, needle: RegExp) {
  return fit.requirement_scores.find((r) => needle.test(r.requirement.toLowerCase()));
}

const VARIANTS = [
  { label: "Base resume", file: "resume.base.md" },
  { label: "IC-optimized", file: "resume.ic.md" },
  { label: "Manager-optimized", file: "resume.manager.md" },
];

async function judge(jd: string, label: string, resumeText: string): Promise<FitResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — export it (it lives in Supabase secrets, not locally).");
    Deno.exit(2);
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: buildFitSystem(label, resumeText),
      tools: [FIT_TOOL],
      tool_choice: { type: "tool", name: "report_fit" },
      messages: buildFitMessages(jd),
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) throw new Error("no tool_use block returned");
  return toolUse.input as FitResult;
}

function printTable(label: string, fit: FitResult) {
  const pct = Math.round(fit.alignment * 100);
  console.log(`\n━━━ ${label} ━━━  alignment ${pct}%  ·  role_type=${fit.role_type}  ·  track=${fit.track_alignment}`);
  for (const r of fit.requirement_scores) {
    const imp = r.importance === "required" ? "core" : "nice";
    const rule = r.rule ? ` [${r.rule}]` : "";
    console.log(
      `  ${r.tier.toUpperCase().padEnd(9)} ${imp.padEnd(4)} ${r.requirement}${rule}\n             ${r.evidence}`,
    );
  }
}

// ── checks ────────────────────────────────────────────────────────────────
type Check = { name: string; pass: boolean; detail: string; critical: boolean };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string, critical = true) {
  checks.push({ name, pass, detail, critical });
}

function run(fits: Record<string, FitResult>) {
  const base = fits["Base resume"], ic = fits["IC-optimized"], mgr = fits["Manager-optimized"];
  const all = Object.entries(fits);

  // 1. Gap stays Gap — MLOps absent in every variant, must be `gap` on all three.
  for (const [label, fit] of all) {
    const r = findReq(fit, /mlops|model serving|feature store|experiment track/);
    check(`MLOps stays Gap — ${label}`, !!r && r.tier === "gap",
      r ? `tier=${r.tier} (expected gap)` : "requirement not found in table");
  }

  // 2. Adjacency, not keyword matching — these MUST earn ≥ adjacent on every variant.
  for (const [label, fit] of all) {
    const t = findReq(fit, /tableau/);
    check(`Looker→Tableau adjacency — ${label}`, !!t && TIER_RANK[t.tier] >= TIER_RANK.adjacent,
      t ? `tier=${t.tier} (expected adjacent/identical, NOT gap)` : "requirement not found");
    const s = findReq(fit, /snowflake/);
    check(`BigQuery→Snowflake adjacency — ${label}`, !!s && TIER_RANK[s.tier] >= TIER_RANK.adjacent,
      s ? `tier=${s.tier} (expected adjacent/identical, NOT gap)` : "requirement not found");
  }

  // 3. GCP→AWS portability (R3) — expected adjacent, but informational (the AWS
  //    requirement names managed services, so aware is defensible).
  for (const [label, fit] of all) {
    const a = findReq(fit, /aws|redshift|glue|\bs3\b/);
    check(`GCP→AWS portability — ${label}`, !!a && TIER_RANK[a.tier] >= TIER_RANK.adjacent,
      a ? `tier=${a.tier} (expected adjacent)` : "requirement not found", false);
  }

  // 4. R5/R7 — "familiar with Airflow", no hands-on → Aware, never Adjacent/Identical.
  for (const [label, fit] of all) {
    const f = findReq(fit, /airflow|orchestrat|dag/);
    check(`Airflow is Aware not Adjacent (R5/R7) — ${label}`,
      !!f && TIER_RANK[f.tier] <= TIER_RANK.aware,
      f ? `tier=${f.tier} (expected aware/gap, NOT adjacent/identical)` : "requirement not found");
  }

  // 5. Differentiation — the leadership requirement must score the manager resume
  //    strictly above the IC resume (added evidence, not wording).
  const lead = (fit: FitResult) => findReq(fit, /lead|mentor|team|roadmap|grow/);
  const mgrLead = lead(mgr), icLead = lead(ic);
  check("Manager > IC on leadership requirement",
    !!mgrLead && !!icLead && TIER_RANK[mgrLead.tier] > TIER_RANK[icLead.tier],
    mgrLead && icLead ? `manager=${mgrLead.tier} vs ic=${icLead.tier}` : "requirement not found on one variant");

  // 6. Differentiation sanity — IC should not score the leadership item as a strong match.
  check("IC leadership is Aware-or-below",
    !!icLead && TIER_RANK[icLead.tier] <= TIER_RANK.aware,
    icLead ? `ic leadership tier=${icLead.tier}` : "not found", false);

  // 7. The technical tiers shouldn't swing between IC and base purely on emphasis
  //    (dbt is named in all three → should be identical everywhere).
  for (const [label, fit] of all) {
    const d = findReq(fit, /dbt/);
    check(`dbt is Identical — ${label}`, !!d && d.tier === "identical",
      d ? `tier=${d.tier}` : "not found", false);
  }
  void base;
}

// ── main ──────────────────────────────────────────────────────────────────
const here = new URL("./fixtures/", import.meta.url);
const jd = jdContext(POSTING);
const fits: Record<string, FitResult> = {};

console.log(`Target JD: ${POSTING.title} (${MODEL})`);
for (const v of VARIANTS) {
  const resumeText = await Deno.readTextFile(new URL(v.file, here));
  const fit = await judge(jd, v.label, resumeText);
  fits[v.label] = fit;
  printTable(v.label, fit);
}

run(fits);

console.log("\n══════════ RED-FLAG CHECKS ══════════");
let criticalFails = 0;
for (const c of checks) {
  const mark = c.pass ? "PASS" : (c.critical ? "FAIL" : "WARN");
  if (!c.pass && c.critical) criticalFails++;
  console.log(`  [${mark}] ${c.name} — ${c.detail}`);
}
const overall = fits["Base resume"];
console.log(
  `\nAlignment spread: base ${Math.round(fits["Base resume"].alignment * 100)}% · ` +
  `IC ${Math.round(fits["IC-optimized"].alignment * 100)}% · ` +
  `manager ${Math.round(fits["Manager-optimized"].alignment * 100)}%`,
);
console.log(criticalFails === 0
  ? "\n✅ All critical checks passed — the tuning holds on this fixture set."
  : `\n❌ ${criticalFails} critical check(s) failed — inspect the tables above and tighten the prompt.`);
void overall;
Deno.exit(criticalFails === 0 ? 0 : 1);
