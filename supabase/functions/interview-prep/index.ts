/**
 * interview-prep — the AI-heavy stages behind the Interview Prep page.
 *
 * Round three: the interview-coach skill folded in (docs/interview-coach-integration.md).
 * Rounds one and two built a per-interview flow — intake, research, mock chat,
 * synthesis — that started from zero every round. This round gives it a memory:
 * every stage reads the candidate-scoped coaching layer (migration 024) into its
 * prompt, and writes its results back, so round nine knows what happened in the
 * previous eight.
 *
 * Two things changed in kind, not just degree:
 *
 *   1. The rubric. Feedback was STAR + a 4-level rating. It's now the coach's
 *      five dimensions — Substance, Structure (where STAR still lives),
 *      Relevance, Credibility, Differentiation — scored 1-5 against the
 *      profile's seniority band, and persisted to coaching_scores so a trend
 *      exists. `rating` is still emitted for the existing UI.
 *   2. The stages. Five new ones ported from skill commands that had no app
 *      surface: concerns, questions, hype, progress, decode.
 *
 * Stages, dispatched on `stage` in the request body:
 *
 *   research    — web-searches the named person/people + the role's functions.
 *   chat        reply    — continues the mock interview in character. Now draws
 *                          on the question bank, so it asks what this company
 *                          actually asked, and logs each question back to it.
 *               feedback — out-of-character critique on the 5-dimension rubric.
 *                          With `draft_answer`: workshop mode, nothing persisted.
 *                          Without: critiques the last committed answer, logs it
 *                          to the transcript AND records a coaching_scores row.
 *   synthesize  — closing prep sheet; reconciles its stories against the
 *                 storybank rather than inventing fresh ones each time.
 *   concerns    — likely interviewer objections + counters.
 *   questions   — questions to ask, tailored to who's in the room.
 *   hype        — pre-interview 3x3 and pre-mortem.
 *   progress    — trend review across rounds (candidate-scoped, no interview_id).
 *   decode      — JD competency extraction and storybank coverage.
 *
 * Coach guidance comes from ./coach-bundle.ts, compiled from the skill repo by
 * dev/build_coach_bundle.mjs. It's the stable half of every system prompt and
 * carries a cache_control breakpoint — the per-turn feedback call would
 * otherwise re-send ~4k tokens of rubric on every single answer.
 *
 * Secrets (unchanged — none new):
 *   ANTHROPIC_API_KEY   — required
 *   JUDGE_MODEL         — optional, defaults to claude-sonnet-4-6
 * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.
 */

import { createClient } from "@supabase/supabase-js";
import { coachGuidance, SOURCE_DIGEST } from "./coach-bundle.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

const RESEARCH_TOOL = {
  name: "report_interview_research",
  description:
    "Report researched background on the role and the specific person/people involved in this interview, grounded in " +
    "what web search and the app's own data surfaced. Only include people actually named (via the linked contact or " +
    "the intake notes) — do not invent attendees.",
  input_schema: {
    type: "object",
    properties: {
      role_summary: {
        type: "string",
        description: "1-2 sentences on what this role is functionally about, beyond the job title.",
      },
      role_functions: {
        type: "array",
        items: { type: "string" },
        description: "The key functional responsibilities/skills this role centers on.",
      },
      people: {
        type: "array",
        description: "Everyone named as being in this interview.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            likely_relationship: {
              type: "string",
              description: "e.g. hiring manager, peer, skip-level, panel member.",
            },
            background: { type: "string", description: "Career summary grounded in what search actually found." },
            what_they_probably_care_about: { type: "array", items: { type: "string" } },
            sources: { type: "array", items: { type: "string" } },
          },
          required: ["name", "background"],
        },
      },
      prep_focus: {
        type: "array",
        items: { type: "string" },
        description: "A few things to make sure to nail given who's in the room and what the role needs.",
      },
    },
    required: ["role_summary", "role_functions", "people"],
  },
};

// The five dimensions, reused across the feedback and synthesis tools so a
// score means the same thing wherever it's produced.
const RUBRIC_SCORES = {
  type: "object",
  description:
    "Score each dimension 1-5 against the candidate's seniority band — a 4 for a new grad is not a 4 for a " +
    "director. Calibrate across the full range; do not default everything to 3.",
  properties: {
    substance: { type: "integer", minimum: 1, maximum: 5, description: "Evidence quality and depth." },
    structure: { type: "integer", minimum: 1, maximum: 5, description: "Narrative clarity — this is where STAR completeness lands." },
    relevance: { type: "integer", minimum: 1, maximum: 5, description: "Did this answer the question actually asked." },
    credibility: { type: "integer", minimum: 1, maximum: 5, description: "Believability and proof; is the candidate's own contribution clear." },
    differentiation: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      description:
        "Could any other qualified candidate have given this exact answer? A complete, well-structured answer with " +
        "no earned insight is a 2 here — that is the correct and useful score, not a harsh one.",
    },
  },
  required: ["substance", "structure", "relevance", "credibility", "differentiation"],
};

const FEEDBACK_TOOL = {
  name: "report_feedback",
  description:
    "Critique the candidate's answer against the question it responded to, out of character, on the five-dimension " +
    "rubric. Keep it short — this is a fast read between rehearsal turns, not a written review.",
  input_schema: {
    type: "object",
    properties: {
      // Retained so the existing chat UI keeps rendering; derive it from the
      // scores rather than judging it separately.
      rating: {
        type: "string",
        enum: ["strong", "solid", "needs_work", "weak"],
        description:
          "A one-word roll-up of the scores below (roughly: mean >=4.5 strong, >=3.5 solid, >=2.5 needs_work, else " +
          "weak). Must be consistent with `scores` — do not rate an answer 'needs_work' if every dimension is 4.",
      },
      scores: RUBRIC_SCORES,
      bottleneck: {
        type: "string",
        enum: ["substance", "structure", "relevance", "credibility", "differentiation"],
        description: "The single dimension that, if fixed, would most improve this answer.",
      },
      root_cause: {
        type: "string",
        description:
          "Why the bottleneck dimension scored low — the underlying cause, not a restatement of the score. " +
          "e.g. 'led with team context and never separated their own decision from the group's'.",
      },
      star: {
        type: "object",
        description:
          "The story as told, mapped to STAR — the evidence behind the `structure` score. Use \"\" for any part the " +
          "candidate didn't actually cover; never invent content that wasn't in the answer.",
        properties: {
          situation: { type: "string" },
          task: { type: "string" },
          action: { type: "string" },
          result: { type: "string" },
        },
        required: ["situation", "task", "action", "result"],
      },
      missing_part: {
        type: "string",
        enum: ["situation", "task", "action", "result", "none"],
        description: "The biggest structural gap. 'none' only if all four STAR parts are clearly present.",
      },
      differentiation_note: {
        type: "string",
        description:
          "One sentence: what in this answer only this candidate could have said — or, if nothing, what earned " +
          "insight is missing and where in their experience it likely lives.",
      },
      what_worked: { type: "array", items: { type: "string" }, description: "At most 2 short bullets." },
      what_to_improve: {
        type: "array",
        items: { type: "string" },
        description:
          "At most 2 short bullets, each under ~15 words. The first must address the `bottleneck` dimension — skip " +
          "wording and delivery nitpicks until the bottleneck is fixed.",
      },
      suggested_rewrite: {
        type: "string",
        description: "Optional: a tightened 3-5 sentence version — only if it would materially help.",
      },
    },
    required: ["rating", "scores", "bottleneck", "root_cause", "star", "missing_part", "what_worked", "what_to_improve"],
  },
};

const SYNTHESIS_TOOL = {
  name: "report_prep_summary",
  description:
    "Synthesize the full prep session (research + mock transcript + coach feedback + the candidate's existing " +
    "storybank) into a final bulleted prep sheet the candidate can skim right before walking in.",
  input_schema: {
    type: "object",
    properties: {
      overall_feedback: {
        type: "object",
        description:
          "A holistic read on the whole mock interview — patterns across all answers, not any single one. Only " +
          "assess this if the transcript actually has candidate answers; otherwise use 'weak' and say plainly " +
          "there's nothing to assess yet.",
        properties: {
          rating: { type: "string", enum: ["strong", "solid", "needs_work", "weak"] },
          scores: RUBRIC_SCORES,
          summary: { type: "string", description: "1-2 sentences on how the interview went overall." },
          strengths: { type: "array", items: { type: "string" }, description: "At most 3 — real patterns across answers." },
          areas_to_improve: {
            type: "array",
            items: { type: "string" },
            description: "At most 3. Prioritize recurring gaps over one-off wording issues.",
          },
          readiness: { type: "string", description: "A short, direct verdict — 'Ready', or the one thing to fix first." },
        },
        required: ["rating", "scores", "summary", "strengths", "areas_to_improve", "readiness"],
      },
      stories: {
        type: "array",
        description:
          "The stories to tell. Reconcile against the existing storybank shown in the context: if a story is " +
          "already banked, reuse its exact title so it updates in place rather than duplicating, and improve it " +
          "with what the rehearsal surfaced. Only add a new title for a genuinely new story.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Reuse the banked title verbatim when this is an existing story." },
            competency: {
              type: "string",
              description:
                "The single competency this story is the primary answer for — must match one entry in " +
                "`competencies`. In a live interview the candidate is asked for a competency, not a company.",
            },
            situation: { type: "string", description: "The concrete context — specific, not generic." },
            task: { type: "string", description: "What the candidate specifically needed to do or decide." },
            action: { type: "string", description: "What the candidate actually did, step by step." },
            result: { type: "string", description: "The concrete outcome — a number, a decision reversed, a system shipped." },
            earned_secret: {
              type: "string",
              description:
                "The insight only this candidate could have from having lived this — the non-obvious thing they'd " +
                "tell a peer over a drink, not the tidy lesson. Leave \"\" if the rehearsal genuinely didn't " +
                "surface one; do not manufacture it.",
            },
            strength: {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description: "How ready this story is to tell as-is. Thin, untested stories are 1-2 — say so.",
            },
            best_for: { type: "string", description: "Optional: secondary competencies this story also answers." },
          },
          required: ["title", "competency", "situation", "task", "action", "result", "strength"],
        },
      },
      competencies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            why_it_matters: { type: "string" },
            evidence: { type: "string", description: "What in the candidate's background/answers proves this." },
          },
          required: ["name"],
        },
      },
      questions_to_ask: { type: "array", items: { type: "string" } },
    },
    required: ["overall_feedback", "stories", "competencies", "questions_to_ask"],
  },
};

const CONCERNS_TOOL = {
  name: "report_concerns",
  description:
    "Name the objections this interviewer is likely to raise about this candidate, ranked by how much damage each " +
    "does, each with a counter grounded in something real.",
  input_schema: {
    type: "object",
    properties: {
      concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            concern: { type: "string", description: "Stated the way the interviewer would think it, not softened." },
            severity: { type: "string", enum: ["dealbreaker", "significant", "minor"] },
            why_they_will_raise_it: { type: "string", description: "What in the resume, fit gap, or JD triggers this." },
            counter: {
              type: "string",
              description:
                "The actual response — evidence-backed, not a reframe of the concern. If the honest answer is a " +
                "gap-handling bridge rather than a rebuttal, say that plainly.",
            },
            story_to_use: { type: "string", description: "Which banked story supports the counter, if one does." },
            confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are they'll raise it." },
          },
          required: ["concern", "severity", "why_they_will_raise_it", "counter", "confidence"],
        },
      },
      biggest_risk: { type: "string", description: "The single concern most likely to end the loop." },
    },
    required: ["concerns", "biggest_risk"],
  },
};

const QUESTIONS_TOOL = {
  name: "report_questions",
  description:
    "Questions the candidate should ask THIS interviewer — calibrated to that person's role and what they can " +
    "actually answer. A question a peer can't answer is a wasted turn.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            ask_who: { type: "string", description: "Which interviewer this lands with, and why they can answer it." },
            why_it_lands: { type: "string", description: "What it signals about the candidate." },
            what_the_answer_tells_you: {
              type: "string",
              description: "What the candidate should actually learn — this is a two-way interview.",
            },
          },
          required: ["question", "why_it_lands", "what_the_answer_tells_you"],
        },
      },
      avoid: {
        type: "array",
        items: { type: "string" },
        description: "Questions to skip this round, with the reason (answered on the careers page, too early to ask, etc.).",
      },
    },
    required: ["questions", "avoid"],
  },
};

const HYPE_TOOL = {
  name: "report_hype",
  description:
    "The thing the candidate reads in the parking lot ten minutes before. Grounded in their actual scores and " +
    "stories — not generic encouragement.",
  input_schema: {
    type: "object",
    properties: {
      hype_reel: {
        type: "array",
        items: { type: "string" },
        description: "3-5 specific, evidence-backed reasons they belong in this room. Cite real results, not traits.",
      },
      three_concerns: {
        type: "array",
        items: { type: "object", properties: { concern: { type: "string" }, counter: { type: "string" } }, required: ["concern", "counter"] },
        description: "Exactly 3 — the concerns most likely to come up, each with a one-line counter.",
      },
      three_questions: { type: "array", items: { type: "string" }, description: "Exactly 3 questions to ask." },
      focus_cue: {
        type: "string",
        description: "One sentence to hold onto mid-interview — the single behavioral correction that matters most.",
      },
      warmup: { type: "array", items: { type: "string" }, description: "A short 10-minute routine, concrete steps." },
      recovery_script: {
        type: "string",
        description: "What to say (and think) after an answer they feel they bombed.",
      },
      pre_mortem: {
        type: "array",
        items: { type: "object", properties: { failure_mode: { type: "string" }, prevention_cue: { type: "string" } }, required: ["failure_mode", "prevention_cue"] },
        description: "Only at directness 5: 2-3 ways this interview goes wrong, each with a prevention cue.",
      },
    },
    required: ["hype_reel", "three_concerns", "three_questions", "focus_cue"],
  },
};

const PROGRESS_TOOL = {
  name: "report_progress",
  description:
    "Trend review across every scored round. Narrate the trajectory — do not just restate the numbers, which the " +
    "candidate can already see.",
  input_schema: {
    type: "object",
    properties: {
      trajectory: { type: "string", description: "2-3 sentences on where they were, where they are, and the direction." },
      dimension_trend: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: ["substance", "structure", "relevance", "credibility", "differentiation"] },
            direction: { type: "string", enum: ["improving", "flat", "declining", "insufficient_data"] },
            note: { type: "string" },
          },
          required: ["dimension", "direction"],
        },
      },
      bottleneck: { type: "string", description: "The dimension holding everything else back right now." },
      calibration_note: {
        type: "string",
        description:
          "What the gap between self-scores and coach scores says. A consistently positive gap means they're " +
          "overrating their answers, which is itself the thing to fix.",
      },
      storybank_health: { type: "string", description: "Coverage, staleness, and the most important missing story." },
      recommended_next: { type: "string", description: "The single highest-leverage next action, with the reason." },
      hard_truth: {
        type: "string",
        description: "Only at directness 5: the hardest true thing that would change their outcome if they heard it.",
      },
    },
    required: ["trajectory", "dimension_trend", "bottleneck", "recommended_next"],
  },
};

const DECODE_TOOL = {
  name: "report_decode",
  description:
    "Read the job description for what it actually demands, then map it against the candidate's storybank to find " +
    "what they can and cannot currently evidence.",
  input_schema: {
    type: "object",
    properties: {
      competencies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            priority: { type: "integer", minimum: 1, description: "1 = most important. Rank by emphasis in the JD, not order." },
            evidence_in_jd: { type: "string", description: "The phrasing that signals it — quote briefly." },
            candidate_coverage: {
              type: "string",
              enum: ["strong_story", "weak_story", "no_story", "unknown"],
              description: "Judge against the storybank in the context. 'unknown' if the storybank is empty.",
            },
            covering_story: { type: "string", description: "The banked story title that covers it, if any." },
          },
          required: ["name", "priority", "evidence_in_jd", "candidate_coverage"],
        },
      },
      signals: {
        type: "array",
        items: { type: "string" },
        description: "What the JD reveals beyond requirements — team maturity, why the role is open, pain being hired against.",
      },
      coverage_gaps: {
        type: "array",
        items: { type: "string" },
        description: "Top-priority competencies with no story or a weak one. This is the storybank work.",
      },
      verify_with_recruiter: {
        type: "array",
        items: { type: "string" },
        description: "Things the JD is genuinely ambiguous about that are worth asking rather than guessing.",
      },
    },
    required: ["competencies", "signals", "coverage_gaps"],
  },
};

type Session = {
  intake_notes: string | null;
  research: {
    role_summary?: string;
    role_functions?: string[];
    people?: Array<{ name: string; title?: string; likely_relationship?: string; background?: string; what_they_probably_care_about?: string[] }>;
    prep_focus?: string[];
  } | null;
  transcript: Array<{ id: string; kind: "interviewer" | "user" | "coach_feedback"; content: string; in_reply_to?: string; created_at: string }>;
};

type PrepContext = {
  success: boolean;
  error?: string;
  interview: { interview_type: string | null; scheduled_at: string | null; notes?: string | null };
  role: { title: string; organization_name: string; job_posting_id?: string };
  company_intel: { growth_stage: string | null };
  fit: { alignment: number | null; summary: string | null; spikes: string[] | null; gaps: string[] | null } | null;
  interviewer: { name: string; title: string | null } | null;
  session: Session | null;
};

type CoachStory = {
  id: string;
  title: string;
  competency?: string;
  situation?: string;
  task?: string;
  action?: string;
  result?: string;
  earned_secret?: string;
  strength?: number;
  best_for?: string;
  last_used_at?: string | null;
};

type CoachContext = {
  profile: {
    track?: string;
    target_roles?: string[];
    seniority_band?: string;
    directness?: number;
    timeline?: string;
    biggest_concern?: string;
    interview_history?: string;
    career_transition?: string;
    transition_status?: string;
    resume_analysis?: Record<string, unknown>;
    active_strategy?: Record<string, unknown>;
    drill_stage?: number;
  } | null;
  stories: CoachStory[];
  story_count: number;
  weak_competencies: string[];
  score_summary: {
    count?: number;
    averages?: Record<string, number | null>;
    calibration_gap?: number | null;
    scores?: Array<Record<string, unknown>>;
  } | null;
  question_bank: { questions?: Array<{ question: string; competency?: string; went?: string; source?: string }> } | null;
};

function contextSeed(ctx: PrepContext): string {
  const parts: string[] = [
    `Role: ${ctx.role.title} @ ${ctx.role.organization_name}`,
    `Interview type: ${ctx.interview.interview_type ?? "unspecified"}`,
  ];
  if (ctx.company_intel.growth_stage) parts.push(`Company stage: ${ctx.company_intel.growth_stage}`);
  if (ctx.interviewer) parts.push(`Linked interviewer contact: ${ctx.interviewer.name}${ctx.interviewer.title ? `, ${ctx.interviewer.title}` : ""}`);
  if (ctx.fit?.summary) parts.push(`Candidate fit summary: ${ctx.fit.summary}`);
  if (ctx.fit?.spikes?.length) parts.push(`Candidate strengths: ${ctx.fit.spikes.join("; ")}`);
  if (ctx.fit?.gaps?.length) parts.push(`Candidate gaps: ${ctx.fit.gaps.join("; ")}`);
  // Scheduling-time context (D5): interviews.notes is where "Competencies: …,
  // Interviewer: …" lands when the round is booked — distinct from the intake
  // box, and skipped when the intake was seeded from it verbatim.
  if (ctx.interview.notes && ctx.interview.notes !== ctx.session?.intake_notes) {
    parts.push(`Notes captured when the round was scheduled:\n${ctx.interview.notes}`);
  }
  if (ctx.session?.intake_notes) parts.push(`What the candidate says this interview covers:\n${ctx.session.intake_notes}`);
  return parts.join("\n");
}

function researchSeed(research: Session["research"]): string {
  if (!research) return "(no research yet)";
  const parts: string[] = [`Role summary: ${research.role_summary ?? "?"}`];
  if (research.role_functions?.length) parts.push(`Role functions: ${research.role_functions.join("; ")}`);
  for (const p of research.people ?? []) {
    parts.push(
      `Person: ${p.name}${p.title ? ` (${p.title})` : ""}${p.likely_relationship ? ` — ${p.likely_relationship}` : ""}\n` +
        `Background: ${p.background ?? "?"}` +
        (p.what_they_probably_care_about?.length ? `\nLikely cares about: ${p.what_they_probably_care_about.join("; ")}` : ""),
    );
  }
  if (research.prep_focus?.length) parts.push(`Prep focus: ${research.prep_focus.join("; ")}`);
  return parts.join("\n\n");
}

/**
 * The candidate-scoped half of the prompt. This is what makes round nine
 * different from round one — without it every stage is starting cold.
 */
function coachSeed(coach: CoachContext | null): string {
  if (!coach) return "(no coaching profile yet — this candidate hasn't set one up)";
  const parts: string[] = [];
  const p = coach.profile;

  if (p) {
    const bits = [
      p.seniority_band ? `Seniority band: ${p.seniority_band} (calibrate every score against THIS band)` : null,
      p.target_roles?.length ? `Target role(s): ${p.target_roles.join(", ")}` : null,
      p.timeline ? `Timeline: ${p.timeline}` : null,
      p.interview_history ? `Interview history: ${p.interview_history.replace(/_/g, " ")}` : null,
      p.biggest_concern ? `Their stated biggest concern: ${p.biggest_concern}` : null,
      p.career_transition
        ? `Career transition: ${p.career_transition} (narrative ${p.transition_status ?? "not yet developed"}) — ` +
          `expect this to dominate at least one question, and treat it as the primary concern`
        : null,
      p.drill_stage ? `Drill stage: ${p.drill_stage}` : null,
    ].filter(Boolean);
    if (bits.length) parts.push(`CANDIDATE PROFILE\n${bits.join("\n")}`);

    if (p.resume_analysis) parts.push(`RESUME ANALYSIS\n${JSON.stringify(p.resume_analysis)}`);
    if (p.active_strategy) parts.push(`ACTIVE COACHING STRATEGY\n${JSON.stringify(p.active_strategy)}`);
  }

  if (coach.stories?.length) {
    const banked = coach.stories
      .map((s) => {
        const head = `- "${s.title}" [${s.competency ?? "uncategorized"}] strength ${s.strength ?? "?"}/5`;
        const star = [s.situation, s.task, s.action, s.result].filter(Boolean).join(" / ");
        const secret = s.earned_secret ? `\n  earned secret: ${s.earned_secret}` : "\n  earned secret: (none captured — this story is not yet differentiated)";
        const used = s.last_used_at ? `\n  last used: ${s.last_used_at}` : "";
        return `${head}${star ? `\n  ${star}` : ""}${secret}${used}`;
      })
      .join("\n");
    parts.push(
      `STORYBANK (${coach.story_count} total, strongest ${coach.stories.length} shown)\n${banked}\n` +
        `Reuse these exact titles when referring to a banked story.`,
    );
  } else {
    parts.push("STORYBANK\n(empty — the candidate has no banked stories yet; say so rather than assuming they have material)");
  }

  if (coach.weak_competencies?.length) {
    parts.push(`WEAK/MISSING COVERAGE\nCompetencies with only a thin story: ${coach.weak_competencies.join(", ")}`);
  }

  const s = coach.score_summary;
  if (s?.count) {
    const avg = s.averages ?? {};
    parts.push(
      `SCORE HISTORY (last ${s.count} scored answers, 1-5 per dimension)\n` +
        `substance ${avg.substance ?? "-"} | structure ${avg.structure ?? "-"} | relevance ${avg.relevance ?? "-"} | ` +
        `credibility ${avg.credibility ?? "-"} | differentiation ${avg.differentiation ?? "-"}` +
        (s.calibration_gap != null
          ? `\nSelf-assessment gap: ${s.calibration_gap} (positive = the candidate rates themselves above the coach — ` +
            `overconfidence is itself the coaching problem; negative = they undersell)`
          : ""),
    );
  }

  const qs = coach.question_bank?.questions ?? [];
  if (qs.length) {
    parts.push(
      `QUESTION BANK (questions this candidate has actually been asked)\n` +
        qs.slice(0, 20).map((q) => `- ${q.question}${q.went ? ` [went: ${q.went}]` : ""}${q.source === "real" ? " (real interview)" : ""}`).join("\n"),
    );
  }

  return parts.length ? parts.join("\n\n") : "(coaching profile exists but is empty)";
}

/** Directness 5 turns on the skill's Challenge Protocol. Below that, same rigor, softer delivery. */
function isLevelFive(coach: CoachContext | null): boolean {
  return (coach?.profile?.directness ?? 5) >= 5;
}

function directnessNote(coach: CoachContext | null): string {
  const level = coach?.profile?.directness ?? 5;
  if (level >= 5) {
    return (
      "\n\nDIRECTNESS: 5 (maximum). Lead with the most important finding whether it's a strength or a gap — do not " +
      "soften the opening. The Challenge Protocol above is active. Challenge without a concrete fix is cruelty: " +
      "every challenge ends with something actionable."
    );
  }
  if (level <= 2) {
    return (
      `\n\nDIRECTNESS: ${level} (gentle). Same diagnosis, warmer delivery. Lead with what's working, frame gaps as ` +
      "the next thing to build. Do not soften the substance of the assessment — only the delivery."
    );
  }
  return `\n\nDIRECTNESS: ${level}. Strengths first, then gaps. Be specific and direct without being harsh.`;
}

async function callClaude(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 500)}`);
  }
  return await res.json();
}

/**
 * System prompt as two blocks: stable coach guidance (cached) then volatile
 * per-candidate context. Order matters — caching is a prefix match, so the
 * bundle has to come first or the breakpoint is worthless.
 */
function systemBlocks(stable: string, volatile: string) {
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: volatile },
  ];
}

function findToolUse(data: { content?: Array<{ type: string; name?: string; input?: unknown }> }, name: string) {
  return (data.content ?? []).reverse().find((b) => b.type === "tool_use" && b.name === name);
}

// Shared by both feedback paths (committed-answer and draft-workshop) — the
// coach persona is the same either way, only what happens to the result differs.
async function critiqueAnswer(
  apiKey: string,
  prep: PrepContext,
  coach: CoachContext | null,
  question: string | null,
  answer: string,
) {
  const extra = isLevelFive(coach) ? ["challenge_lenses"] : [];
  const data = await callClaude(apiKey, {
    model: MODEL,
    max_tokens: 1200,
    system: systemBlocks(
      "You are an interview coach, stepping OUT of character to critique one answer against the question it " +
        "responded to. Score it on the five-dimension rubric below, calibrated to the candidate's seniority band, " +
        "and name the single bottleneck dimension plus its root cause. Be concise — a couple of short bullets, not " +
        "paragraphs. Do not manufacture criticism an answer doesn't have, and do not inflate: a well-structured " +
        "answer that any qualified candidate could have given genuinely scores low on Differentiation, and saying " +
        "so is the useful thing. Call report_feedback.\n\n" +
        coachGuidance("feedback", extra),
      `${contextSeed(prep)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
    ),
    tools: [FEEDBACK_TOOL],
    tool_choice: { type: "tool", name: "report_feedback" },
    messages: [
      {
        role: "user",
        content:
          `${question ? `Question asked: ${question}\n\n` : ""}` +
          `Candidate's answer: ${answer}`,
      },
    ],
  });
  const toolUse = findToolUse(data, "report_feedback");
  return toolUse ? (toolUse.input as Record<string, unknown>) : null;
}

/**
 * The five ported command stages all have the same shape: one forced-tool call
 * over the prep + coaching context, persisted as a coaching_artifact. Only the
 * persona, tool, and fragment set differ.
 */
// `kind` is the coaching_artifacts value and is NOT always the stage name:
// the stage keeps the skill's command name (`questions`) while the stored kind
// is the more explicit `questions_to_ask` the migration's CHECK constraint
// expects. Keep the two in sync with migration 024 if either changes.
const ARTIFACT_STAGES = {
  concerns: {
    kind: "concerns",
    tool: CONCERNS_TOOL,
    toolName: "report_concerns",
    maxTokens: 2000,
    persona:
      "You surface the objections an interviewer will actually raise about this candidate, and give them a real " +
      "counter for each. Rank by damage, not by how easy they are to answer. If the honest counter is a " +
      "gap-handling bridge rather than a rebuttal, say that — a fabricated counter fails the moment it's probed. " +
      "Ground every concern in something concrete from the resume analysis, fit gaps, or JD. Call report_concerns.",
  },
  questions: {
    kind: "questions_to_ask",
    tool: QUESTIONS_TOOL,
    toolName: "report_questions",
    maxTokens: 1500,
    persona:
      "You write the questions the candidate asks at the end of the round. Calibrate to who is actually in the " +
      "room — a question only a hiring manager can answer is wasted on a peer, and a question answered on the " +
      "careers page costs credibility. Remember the candidate is also evaluating them. Call report_questions.",
  },
  hype: {
    kind: "hype",
    tool: HYPE_TOOL,
    toolName: "report_hype",
    maxTokens: 2000,
    persona:
      "You write the thing the candidate reads ten minutes before walking in. Every line is grounded in their " +
      "actual scores, stories, and results — generic encouragement is worse than nothing here, because they know " +
      "it's generic. If there's no score history or storybank to draw on, build from the resume and say plainly " +
      "that's what you're working from. Call report_hype.",
  },
  progress: {
    kind: "progress",
    tool: PROGRESS_TOOL,
    toolName: "report_progress",
    maxTokens: 2000,
    persona:
      "You review the candidate's trajectory across every scored round. Narrate the trend — they can already read " +
      "the numbers; what they can't see is what the numbers mean. If there's too little data to call a trend, say " +
      "so rather than inventing one. Call report_progress.",
  },
  decode: {
    kind: "decode",
    tool: DECODE_TOOL,
    toolName: "report_decode",
    maxTokens: 2500,
    persona:
      "You read a job description for what it actually demands underneath the boilerplate, then map those " +
      "competencies against what the candidate can currently evidence from their storybank. Be honest about " +
      "coverage — a competency with no story is the finding, not something to paper over. Call report_decode.",
  },
} as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "content-type": "application/json" },
    });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ success: false, error: "ANTHROPIC_API_KEY not set" }, 500);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ success: false, error: "missing Authorization" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ success: false, error: "invalid auth" }, 401);
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);

    const { interview_id, stage, action, message, draft_answer, jd_text } = await req.json();
    if (!stage) return json({ success: false, error: "stage required" }, 400);

    // `progress` is candidate-scoped — it reviews the whole search, not one
    // round — so it's the one stage that runs without an interview_id.
    const needsInterview = stage !== "progress";
    if (needsInterview && !interview_id) {
      return json({ success: false, error: "interview_id required" }, 400);
    }

    // The coaching layer is loaded for every stage; it's the whole point.
    const { data: coachRaw, error: coachErr } = await admin.rpc("get_coaching_context", {
      p_interview_id: interview_id ?? null,
      p_user_id: userId,
    });
    if (coachErr) throw coachErr;
    const coach = (coachRaw ?? null) as CoachContext | null;

    // ---- progress: candidate-scoped, no prep session involved ---------------
    if (stage === "progress") {
      const cfg = ARTIFACT_STAGES.progress;
      if (!coach?.score_summary?.count) {
        return json(
          { success: false, error: "no scored rounds yet — rehearse and get feedback first, then progress has something to review" },
          400,
        );
      }
      const extra = isLevelFive(coach) ? ["challenge_lenses", "challenge_avoidance"] : [];
      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: cfg.maxTokens,
        system: systemBlocks(
          `${cfg.persona}\n\n${coachGuidance("progress", extra)}`,
          `=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [cfg.tool],
        tool_choice: { type: "tool", name: cfg.toolName },
        messages: [{ role: "user", content: "Review my trajectory across every scored round and call report_progress." }],
      });
      const toolUse = findToolUse(data, cfg.toolName);
      if (!toolUse) return json({ success: false, error: "progress did not return a review — try again" }, 502);

      const { data: saved, error: saveErr } = await admin.rpc("save_coaching_artifact", {
        p_kind: "progress",
        p_content: toolUse.input,
        p_interview_id: null,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(saved);
    }

    // ---- everything else needs the prep session ----------------------------
    const { data: ctx, error: ctxErr } = await admin.rpc("get_interview_prep_session", {
      p_interview_id: interview_id,
      p_user_id: userId,
    });
    if (ctxErr) throw ctxErr;
    const prep = ctx as PrepContext;
    if (!prep?.success) return json({ success: false, error: prep?.error ?? "interview not found" }, 404);
    if (!prep.session) {
      return json({ success: false, error: "no prep session yet — call start_interview_prep first" }, 400);
    }

    if (stage === "research") {
      const seed = contextSeed(prep);
      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 3000,
        system: systemBlocks(
          "You research the people and role behind a job interview so a candidate can prep. Use web_search to find " +
            "each named person's public background (current/prior roles, focus areas) — disambiguate using their " +
            "title and company. If search turns up too little on someone, say so plainly rather than guessing. " +
            "Then call report_interview_research.\n\n" +
            coachGuidance("research"),
          `=== COACHING CONTEXT ===\n${coachSeed(coach)}`,
        ),
        tools: [WEB_SEARCH_TOOL, RESEARCH_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: `Research this interview and report on the role + people.\n\n${seed}` }],
      });
      const toolUse = findToolUse(data, "report_interview_research");
      if (!toolUse) return json({ success: false, error: "research did not return a report — try again" }, 502);

      const { data: fresh, error: saveErr } = await admin.rpc("save_interview_prep_research", {
        p_interview_id: interview_id,
        p_research: toolUse.input,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(fresh);
    }

    if (stage === "chat") {
      const transcript = [...(prep.session.transcript ?? [])];

      if (action === "feedback") {
        // Workshop mode: critique a draft that hasn't been sent yet, against
        // the most recent question. Nothing is persisted — this is how you
        // iterate on wording before committing an answer, without it being
        // read as your real reply and advancing the interview. No score is
        // recorded either: a draft isn't a performance.
        if (typeof draft_answer === "string" && draft_answer.trim()) {
          const priorQuestion = [...transcript].reverse().find((m) => m.kind === "interviewer");
          const feedback = await critiqueAnswer(apiKey, prep, coach, priorQuestion?.content ?? null, draft_answer);
          if (!feedback) return json({ success: false, error: "coach did not return feedback — try again" }, 502);
          return json({ success: true, feedback, question: priorQuestion?.content ?? null });
        }

        // Committed-answer mode: critique the last answer you actually sent,
        // logged to the transcript (the "Get feedback on my last answer" button).
        const lastUser = [...transcript].reverse().find((m) => m.kind === "user");
        if (!lastUser) return json({ success: false, error: "no answer yet to give feedback on" }, 400);
        const priorQuestion = [...transcript].reverse().find((m) => m.kind === "interviewer" && m.created_at < lastUser.created_at);

        const feedback = await critiqueAnswer(apiKey, prep, coach, priorQuestion?.content ?? null, lastUser.content);
        if (!feedback) return json({ success: false, error: "coach did not return feedback — try again" }, 502);

        // The write-back that makes a trend possible. Best-effort: a scoring
        // hiccup must not cost the candidate the feedback they just earned.
        const scores = feedback.scores as Record<string, number> | undefined;
        try {
          await admin.rpc("record_coaching_score", {
            p_source: "mock",
            p_interview_id: interview_id,
            p_round_label: prep.interview.interview_type ?? null,
            p_substance: scores?.substance ?? null,
            p_structure: scores?.structure ?? null,
            p_relevance: scores?.relevance ?? null,
            p_credibility: scores?.credibility ?? null,
            p_differentiation: scores?.differentiation ?? null,
            p_root_cause: (feedback.root_cause as string) ?? null,
            p_question: priorQuestion?.content ?? null,
            p_notes: (feedback.differentiation_note as string) ?? null,
            p_user_id: userId,
          });
        } catch (e) {
          console.error("record_coaching_score failed (feedback still returned):", (e as Error).message);
        }

        transcript.push({
          id: crypto.randomUUID(),
          kind: "coach_feedback",
          content: JSON.stringify(feedback),
          in_reply_to: lastUser.id,
          created_at: new Date().toISOString(),
        });
        const { data: fresh, error: saveErr } = await admin.rpc("save_interview_prep_transcript", {
          p_interview_id: interview_id,
          p_transcript: transcript,
          p_user_id: userId,
        });
        if (saveErr) throw saveErr;
        return json(fresh);
      }

      // action "reply" (default): continue the mock interview in character.
      if (message) {
        transcript.push({
          id: crypto.randomUUID(),
          kind: "user",
          content: message,
          created_at: new Date().toISOString(),
        });
      }

      const dialogue = transcript
        .filter((m) => m.kind === "interviewer" || m.kind === "user")
        .map((m) => ({ role: m.kind === "interviewer" ? "assistant" as const : "user" as const, content: m.content }));

      if (dialogue.length === 0) {
        dialogue.push({ role: "user", content: "(the candidate has entered the room — begin the interview)" });
      }

      const feedbackCount = transcript.filter((m) => m.kind === "coach_feedback").length;

      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 500,
        system: systemBlocks(
          "You are role-playing as the interviewer(s) in a mock job interview, to help a candidate rehearse. Stay " +
            "in character as a real person conducting this specific interview — ask one realistic question at a " +
            "time, react briefly to the candidate's last answer the way an attentive interviewer would (no " +
            "scoring, no meta commentary), then ask the next question or a natural follow-up. Keep each turn to a " +
            "few sentences.\n\n" +
            "Draw questions from the interview type, the researched role/people background, and the question bank " +
            "in the coaching context — questions this company or a similar round has actually asked are the most " +
            "valuable ones to rehearse, and a question the candidate previously handled badly is worth returning " +
            "to. Probe competencies where their storybank is thin: the point of rehearsal is to find the gaps " +
            "before the real interviewer does.\n\n" +
            coachGuidance("chat_reply"),
          `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}` +
            (feedbackCount > 0
              ? `\n\n(The candidate has requested coach feedback ${feedbackCount} time(s) so far — stay in character regardless.)`
              : ""),
        ),
        messages: dialogue,
      });
      const textBlock = (data.content ?? []).find((b: { type: string }) => b.type === "text") as { text?: string } | undefined;
      if (!textBlock?.text) return json({ success: false, error: "interviewer did not respond — try again" }, 502);

      transcript.push({
        id: crypto.randomUUID(),
        kind: "interviewer",
        content: textBlock.text,
        created_at: new Date().toISOString(),
      });

      // Log the question so the bank grows as they rehearse. Best-effort.
      try {
        await admin.rpc("record_interview_question", {
          p_question: textBlock.text,
          p_interview_id: interview_id,
          p_question_type: prep.interview.interview_type ?? null,
          p_source: "mock",
          p_user_id: userId,
        });
      } catch (e) {
        console.error("record_interview_question failed (turn still returned):", (e as Error).message);
      }

      const { data: fresh, error: saveErr } = await admin.rpc("save_interview_prep_transcript", {
        p_interview_id: interview_id,
        p_transcript: transcript,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(fresh);
    }

    if (stage === "synthesize") {
      const transcriptText = (prep.session.transcript ?? [])
        .map((m) => {
          if (m.kind === "interviewer") return `Interviewer: ${m.content}`;
          if (m.kind === "user") return `Candidate: ${m.content}`;
          const fb = (() => { try { return JSON.parse(m.content); } catch { return null; } })();
          return `Coach feedback (${fb?.rating ?? "?"}): ${(fb?.what_to_improve ?? []).join("; ")}`;
        })
        .join("\n");

      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 4000,
        system: systemBlocks(
          "You close out an interview prep session. Read the role/research context, the mock-interview transcript, " +
            "any coach feedback, and the candidate's existing storybank, then call report_prep_summary with a " +
            "tight, specific closing sheet.\n\n" +
            "Identify the competencies FIRST, then write each story pre-broken into situation/task/action/result — " +
            "concrete and specific, grounded in what the candidate actually said, not generic advice — and tag it " +
            "with the single competency it's the strongest answer for. In a live interview the candidate gets " +
            "asked for a competency, not a company, so that tag is how they'll find the right story fast.\n\n" +
            "Reconcile against the storybank rather than starting fresh: reuse a banked story's exact title when " +
            "you're improving an existing story, and only mint a new title for a genuinely new one. Pull out the " +
            "earned secret where the rehearsal surfaced one — that's what moves a story from 'complete' to " +
            "'only this candidate could have told it'. Give an honest overall_feedback verdict on the whole " +
            "rehearsal (patterns across answers, not a single moment), and keep every field short.\n\n" +
            coachGuidance("synthesize"),
          `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [SYNTHESIS_TOOL],
        tool_choice: { type: "tool", name: "report_prep_summary" },
        messages: [
          {
            role: "user",
            content:
              `=== MOCK INTERVIEW TRANSCRIPT ===\n${transcriptText || "(no rehearsal turns yet)"}\n\n` +
              "Call report_prep_summary.",
          },
        ],
      });
      const toolUse = findToolUse(data, "report_prep_summary");
      if (!toolUse) return json({ success: false, error: "synthesis did not return a summary — try again" }, 502);

      const synthesis = toolUse.input as {
        stories?: Array<Record<string, unknown>>;
        overall_feedback?: { scores?: Record<string, number>; summary?: string };
      };

      // Write the session's stories into the durable storybank. Title is the
      // natural key, so re-running synthesis enriches rather than duplicates.
      // Best-effort per story: one bad row shouldn't lose the whole sheet.
      for (const s of synthesis.stories ?? []) {
        try {
          await admin.rpc("upsert_story", {
            p_title: s.title as string,
            p_competency: (s.competency as string) ?? null,
            p_situation: (s.situation as string) ?? null,
            p_task: (s.task as string) ?? null,
            p_action: (s.action as string) ?? null,
            p_result: (s.result as string) ?? null,
            // "" means the rehearsal genuinely didn't surface one — store null
            // rather than an empty string so the gap stays visible.
            p_earned_secret: (s.earned_secret as string) || null,
            p_strength: (s.strength as number) ?? null,
            p_best_for: (s.best_for as string) ?? null,
            p_source: "synthesis",
            p_source_interview_id: interview_id,
            p_user_id: userId,
          });
        } catch (e) {
          console.error(`upsert_story failed for "${s.title}":`, (e as Error).message);
        }
      }

      // One round-level score row, so the trend has a point per rehearsal.
      const overall = synthesis.overall_feedback?.scores;
      if (overall) {
        try {
          await admin.rpc("record_coaching_score", {
            p_source: "mock",
            p_interview_id: interview_id,
            p_round_label: `${prep.interview.interview_type ?? "mock"} — full rehearsal`,
            p_substance: overall.substance ?? null,
            p_structure: overall.structure ?? null,
            p_relevance: overall.relevance ?? null,
            p_credibility: overall.credibility ?? null,
            p_differentiation: overall.differentiation ?? null,
            p_notes: synthesis.overall_feedback?.summary ?? null,
            p_user_id: userId,
          });
        } catch (e) {
          console.error("record_coaching_score (synthesis) failed:", (e as Error).message);
        }
      }

      const { data: fresh, error: saveErr } = await admin.rpc("save_interview_prep_synthesis", {
        p_interview_id: interview_id,
        p_synthesis: toolUse.input,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(fresh);
    }

    // ---- the ported command stages: concerns / questions / hype / decode ----
    if (stage in ARTIFACT_STAGES) {
      const key = stage as keyof typeof ARTIFACT_STAGES;
      const cfg = ARTIFACT_STAGES[key];
      const extra = isLevelFive(coach) ? ["challenge_lenses"] : [];

      if (key === "decode" && !jd_text) {
        return json({ success: false, error: "decode needs jd_text — paste the job description" }, 400);
      }

      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: cfg.maxTokens,
        system: systemBlocks(
          `${cfg.persona}\n\n${coachGuidance(key, extra)}`,
          `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [cfg.tool],
        tool_choice: { type: "tool", name: cfg.toolName },
        messages: [
          {
            role: "user",
            content:
              key === "decode"
                ? `=== JOB DESCRIPTION ===\n${jd_text}\n\nCall ${cfg.toolName}.`
                : `Call ${cfg.toolName} for this interview.`,
          },
        ],
      });
      const toolUse = findToolUse(data, cfg.toolName);
      if (!toolUse) return json({ success: false, error: `${key} did not return a result — try again` }, 502);

      const { data: saved, error: saveErr } = await admin.rpc("save_coaching_artifact", {
        p_kind: cfg.kind,
        p_content: toolUse.input,
        p_interview_id: interview_id,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(saved);
    }

    return json({ success: false, error: `unknown stage "${stage}"`, coach_bundle: SOURCE_DIGEST }, 400);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
