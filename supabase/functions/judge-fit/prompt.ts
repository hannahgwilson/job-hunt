/**
 * judge-fit prompt — the persona, the structured-output tool, and the request
 * builders. Extracted from index.ts so it has exactly ONE definition: the edge
 * function (index.ts) imports it for production, and the tuning harness
 * (harness/run.ts) imports the SAME constants so it validates the real prompt
 * instead of a copy that silently drifts.
 *
 * Pure module: no Deno.env, no I/O, no Deno.serve — safe to import anywhere.
 * The scoring framework + adjacency rules this encodes are specified in
 * /resume-scoring-prompt-instructions.md.
 */

// Structured-output tool: forces Claude to return exactly these fields.
export const FIT_TOOL = {
  name: "report_fit",
  description:
    "Report how well a single resume fits a specific job description. First decide whether the JD is an individual-contributor or a people-management role, then judge the resume against the skills THAT role type demands. Be concrete and specific to THIS resume and THIS JD — never generic.",
  input_schema: {
    type: "object",
    properties: {
      role_type: {
        type: "string",
        enum: ["ic", "manager", "hybrid", "unclear"],
        description:
          "What track is THIS JD, judged from its responsibilities (not just the title)? ic = individual contributor (own technical/functional delivery, no direct reports); manager = people leadership (direct reports, hiring, performance, org-building is the core of the job); hybrid = player-coach / lead (real IC work AND people leadership); unclear = the JD doesn't say. Decide this first — it sets which skills matter.",
      },
      track_alignment: {
        type: "string",
        enum: ["match", "stretch", "mismatch"],
        description:
          "How well the resume's own track matches role_type. match = the resume is clearly for this track; stretch = adjacent / could be argued (e.g. a senior IC reaching for a lead role); mismatch = wrong track (e.g. a pure people-manager resume for a hands-on IC role, or vice versa) — a real risk to the application, call it out.",
      },
      requirement_scores: {
        type: "array",
        description:
          "The per-requirement adjacency table — fill this in BEFORE the alignment number (it is the chain-of-thought that keeps the score honest). The ROW SET is a property of the ROLE, not the resume: use the JD's listed Requirements and Nice to have entries (given in the JD context) as your rows — ONE row per listed item, preserving their wording and order, so the same role yields the SAME table for every resume and only the tier/evidence change. Set importance from which list the item came (Requirements → required, Nice to have → nice_to_have). ONLY if the JD lists no requirements at all should you extract the material ones from the JD text yourself. Tier each against the resume using the four-tier framework and the adjacency rules in the system prompt — never literal keyword matching, never a Gap upgraded by wording alone.",
        items: {
          type: "object",
          properties: {
            requirement: { type: "string", description: "The JD requirement, in a few words (e.g. 'Tableau / BI dashboards', 'Airflow orchestration')." },
            importance: {
              type: "string",
              enum: ["required", "nice_to_have"],
              description: "Is this a core / must-have requirement or a nice-to-have? Drives the weighting of the average — core requirements dominate the score.",
            },
            tier: {
              type: "string",
              enum: ["identical", "adjacent", "aware", "gap"],
              description: "identical (1.0) = same tool named on the resume; adjacent (0.75) = different tool, same category AND paradigm, interview-demonstrable; aware (0.2) = conceptual / alongside-teams / self-described 'familiar with', not operated; gap (0.0) = no meaningful exposure.",
            },
            rule: {
              type: "string",
              description: "For an adjacent or aware call, cite the rule that justifies it (e.g. 'R1', 'R3', 'R5'). Empty for identical/gap. This is what makes the score defensible in an interview.",
            },
            evidence: {
              type: "string",
              description: "The specific resume evidence (or its absence) behind this tier — quote/paraphrase the bullet. 'No evidence in resume body' for a gap. Do NOT infer from job titles.",
            },
          },
          required: ["requirement", "importance", "tier", "evidence"],
        },
      },
      alignment: {
        type: "number",
        description:
          "0..1 fit. Derive it from requirement_scores as the IMPORTANCE-weighted average of the tier weights (identical 1.0, adjacent 0.75, aware 0.2, gap 0.0), giving 'required' items far more weight than 'nice_to_have' (a useful default is ~4:1). It should land close to that computed average — do not free-hand a number that contradicts your own table. 100% is not required for a strong fit. Sanity bands: 0.90-1.0 = clears every core requirement at identical/adjacent; 0.75-0.89 = clears the core, only minor/secondary gaps; 0.55-0.74 = one real core gap or several core items only at adjacent/aware — a stretch worth a tailored resume; 0.35-0.54 = misses multiple core requirements OR a track mismatch; below 0.35 = wrong role. A track mismatch (e.g. IC resume vs manager role) caps alignment in the 0.35-0.5 band even if individual skills look strong.",
      },
      summary: {
        type: "string",
        description: "2-4 sentence read of this resume against the JD. Name the role type and, if the resume is the wrong track for it, lead with that.",
      },
      spikes: {
        type: "array",
        items: { type: "string" },
        description: "Specific requirements this resume clearly satisfies (the strengths to lead with).",
      },
      gaps: {
        type: "array",
        items: { type: "string" },
        description: "Specific requirements this resume does NOT evidence, or evidences weakly.",
      },
      tweaks: {
        type: "array",
        description:
          "A few high-leverage, non-generic edits to better match this JD. Assume BOTH a human reviewer and an ATS / AI keyword screen will read the resume.",
        items: {
          type: "object",
          properties: {
            section: { type: "string", description: "Which resume section/bullet to change." },
            suggestion: { type: "string", description: "The concrete proposed change." },
            rationale: { type: "string", description: "Why it helps against this JD (human + ATS)." },
          },
          required: ["suggestion"],
        },
      },
    },
    required: ["role_type", "track_alignment", "requirement_scores", "alignment", "summary", "spikes", "gaps", "tweaks"],
  },
};

// Persona + stable rubric live in the system prompt (better adherence). For
// prompt caching, the cache key is a prefix match (render order tools → system →
// messages), so the STABLE content must come first: tool + this persona + the
// resume are identical across every posting in a batch, the JD is what varies.
// judgeOne therefore puts the resume in the system array with a cache_control
// breakpoint and leaves only the JD in the user turn — so a resume scored across
// a big list of roles is written to cache once and read at ~0.1x thereafter.
// (Earlier this prompt put the JD *before* the resume in one user message, which
// changed the prefix every posting and cached nothing.)
export const FIT_SYSTEM =
  "You are a sharp hiring manager who also knows how ATS / AI keyword screens work. " +
  "You screen one resume against one job description and judge fit honestly — never inflate, never deflate. " +
  "Crucially: decide whether the JD is an individual-contributor role or a people-management role FIRST, " +
  "because the skills that matter differ sharply. A people-manager role rewards leadership, hiring, " +
  "headcount/org scope, cross-functional influence, and outcomes delivered THROUGH a team; an IC role " +
  "rewards hands-on depth, individual ownership, and technical/functional craft. A resume aimed at the " +
  "wrong track is a genuine misalignment — surface it rather than scoring around it.\n\n" +

  "HOW TO SCORE — adjacency, not keyword matching. Most naive screens do literal keyword matching: a " +
  "candidate with Looker gets zero credit when the JD says Tableau. That is wrong. Real skill transfers " +
  "across adjacent tools — but it does NOT transfer infinitely, and a genuine gap must stay a gap. " +
  "Classify the candidate's evidence for EACH JD requirement into exactly one of four tiers:\n" +
  "  • Identical (weight 1.0) — the same tool/skill is named explicitly on the resume.\n" +
  "  • Adjacent (weight 0.75) — a DIFFERENT tool in the SAME category AND the SAME paradigm; the candidate " +
  "could credibly demonstrate the skill in an interview, not just name-drop the JD's tool.\n" +
  "  • Aware (weight 0.2) — worked alongside teams using it, or has conceptual knowledge, but has not " +
  "operated it themselves.\n" +
  "  • Gap (weight 0.0) — no meaningful exposure; the candidate would have to learn it from scratch.\n\n" +

  "ADJACENCY RULES — reason from these PRINCIPLES to whatever tool you encounter. Do NOT rely on a memorized " +
  "list of tool equivalencies; derive the call. These generalize across data science, data/analytics " +
  "engineering, and software engineering:\n" +
  "  R1 Same job-to-be-done, same data paradigm = Adjacent (e.g. two code-first BI tools; two columnar " +
  "cloud warehouses). The candidate must be able to articulate the paradigm, not just the name.\n" +
  "  R2 Same broad category but a fundamentally different model = Aware at best, NOT Adjacent (e.g. a " +
  "drag-and-drop BI tool vs. a semantic-layer BI tool). Grant Adjacent only with concrete evidence of " +
  "bridging the gap.\n" +
  "  R3 Cloud portability is real but bounded: hands-on with one major cloud (GCP/AWS/Azure) gives Adjacent " +
  "credit for core compute/storage/orchestration on another — but NOT for a platform-specific managed " +
  "service with no clear analog.\n" +
  "  R4 Managed vs. open-source variants of the same tool = Adjacent (the engineering patterns match; the " +
  "operational difference is shallow).\n" +
  "  R5 Orchestration/workflow tools require hands-on evidence: 'worked with teams that use X' is Aware, not " +
  "Adjacent. The candidate must have personally written or scheduled jobs in the tool.\n" +
  "  R6 Adjacent ≠ a different discipline. Exposure to a domain's OUTPUTS (e.g. consuming ML scores, using AI " +
  "tooling) is not expertise in that domain's INFRASTRUCTURE (e.g. MLOps: model serving, experiment " +
  "tracking, feature stores). Score the deeper discipline above Aware only with direct hands-on evidence. " +
  "(This is an EXAMPLE of a boundary, not a special case for ML — apply the same outputs-vs-infrastructure " +
  "test to any discipline.)\n" +
  "  R7 Honor self-assessed uncertainty: 'exposure to', 'familiar with', 'knowledge of' on the resume = " +
  "Aware. Do not upgrade it to Adjacent.\n\n" +

  "GUARDRAILS:\n" +
  "  • The requirement table's ROWS are set by the JD, not the resume: use the JD's stated Requirements / " +
  "Nice to have as the row set so the same role is scored against the same checklist for every resume — only " +
  "the tier and evidence change per resume. Do not add, drop, or re-word rows to suit a particular resume.\n" +
  "  • Evidence must appear in the resume BODY. Do NOT infer a skill from a job title alone.\n" +
  "  • A gap is a gap. Better wording on a resume must NEVER turn a Gap into Adjacent — only added, concrete " +
  "evidence can. Score the same requirement the same tier no matter how polished the prose.\n" +
  "  • Weight the JD's required / must-have requirements far above its nice-to-haves: missing a nice-to-have " +
  "should barely move the score; missing a core requirement should. A resume need not match everything to " +
  "be a strong fit.\n" +
  "Build the per-requirement table FIRST, cite the rule you applied for every Adjacent or Aware call, then " +
  "derive the overall alignment as the requirement-weighted average of the tier weights.";

// Structured render of a posting into the JD text the judge reads.
export function jdContext(p: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push(`Title: ${p.title ?? "(untitled)"}`);
  if (p.location) parts.push(`Location: ${p.location}`);
  if (p.remote_policy) parts.push(`Remote policy: ${p.remote_policy}`);
  if (p.salary_min || p.salary_max) parts.push(`Salary: ${p.salary_min ?? "?"}–${p.salary_max ?? "?"}`);
  const reqs = (p.requirements as string[] | null) ?? [];
  if (reqs.length) parts.push(`Requirements:\n- ${reqs.join("\n- ")}`);
  const nice = (p.nice_to_haves as string[] | null) ?? [];
  if (nice.length) parts.push(`Nice to have:\n- ${nice.join("\n- ")}`);
  if (p.notes) parts.push(`Notes / JD excerpt:\n${p.notes}`);
  if (p.url) parts.push(`Source: ${p.url}`);
  return parts.join("\n\n");
}

// The cached system prefix: persona + rubric, then the resume with a cache
// breakpoint (identical across every posting judged against this resume).
export function buildFitSystem(resumeLabel: string, resumeText: string) {
  return [
    { type: "text", text: FIT_SYSTEM },
    {
      type: "text",
      text: `=== RESUME (variant label: ${resumeLabel}) ===\n${resumeText}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

// The volatile user turn: only the JD changes per posting.
export function buildFitMessages(jd: string) {
  return [
    {
      role: "user",
      content:
        `Decide the role type first. Then build the per-requirement adjacency table (requirement_scores): take ` +
        `the JD's listed Requirements and Nice to have items below as your rows (one each, same wording and order — ` +
        `the row set is the same for this role regardless of resume), and tier each against the resume above ` +
        `Identical/Adjacent/Aware/Gap by the rules, citing the rule for every Adjacent or Aware call — and only ` +
        `THEN set alignment as the importance-weighted average of that table.\n\n` +
        `=== JOB DESCRIPTION ===\n${jd}\n\n` +
        `Call report_fit. Keep requirement_scores/spikes/gaps/tweaks specific to this resume and this JD, and frame them for the role type you determined.`,
    },
  ];
}

// The shape report_fit returns (shared by the function and the harness).
export interface FitResult {
  role_type: "ic" | "manager" | "hybrid" | "unclear";
  track_alignment: "match" | "stretch" | "mismatch";
  requirement_scores: Array<{
    requirement: string;
    importance: "required" | "nice_to_have";
    tier: "identical" | "adjacent" | "aware" | "gap";
    rule?: string;
    evidence: string;
  }>;
  alignment: number;
  summary: string;
  spikes: string[];
  gaps: string[];
  tweaks: Array<{ section?: string; suggestion: string; rationale?: string }>;
}
