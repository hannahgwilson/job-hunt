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
 *   decode      — JD competency extraction and storybank coverage. Scoped to the
 *                 POSTING (job_posting_id), not the round: a job description
 *                 belongs to the role, so this runs once at intake instead of
 *                 once per round with a manual JD paste each time.
 *   consolidate_stories
 *               — folds every telling of a story across all prep syntheses into
 *                 one library entry. Candidate-scoped. PASS 1: groups the
 *                 tellings and returns titles + variant titles only.
 *   consolidate_cluster
 *               — PASS 2: assembles one of those clusters into a story, best-of
 *                 per STAR component, from just that cluster's tellings. One
 *                 request per story, because one request for all of them ran
 *                 past the 150s Edge Function ceiling.
 *                 Both PROPOSE rather than persist — a bad merge loses the one
 *                 telling that had the number in it, so the client applies what
 *                 the candidate accepts.
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

/**
 * Consolidation is TWO calls, and the split is not an optimisation — it's what
 * makes the pass finish at all.
 *
 * It used to be one: every telling from every prep synthesis in a single prompt,
 * `max_tokens: 8000`, asked to both cluster AND write the assembled STAR for
 * each cluster. That is output-bound, and at ~40 syntheses it stopped returning
 * inside the 150s Edge Function ceiling — the gateway killed it at 150,105ms and
 * the client saw an opaque non-2xx. Worse, nothing checked `stop_reason`, so a
 * run that *did* squeak in under the wire could have truncated the tool call
 * mid-JSON and looked like a model failure.
 *
 * So: PLAN decides what the stories are, reading a compact one-line index of
 * every telling and emitting titles + variant titles only (small output, and it
 * scales with the number of distinct stories rather than the volume of text).
 * ASSEMBLE then writes one story at a time from just that cluster's tellings —
 * small in, small out, one request each. Both fit comfortably, and each story
 * gets the model's whole attention instead of a share of one 8k budget.
 */
const CONSOLIDATE_PLAN_TOOL = {
  name: "report_consolidation_plan",
  description:
    "Decide what the candidate's stories actually ARE: group every telling you were shown into one cluster per " +
    "underlying event. Do not write the stories — that happens one at a time afterwards, with the full text in hand.",
  input_schema: {
    type: "object",
    properties: {
      clusters: {
        type: "array",
        description:
          "One entry per underlying story. A story told four times across four prep sessions is ONE cluster with " +
          "four variant titles, not four clusters.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "The anchor title if this story matches one of the candidate's anchors — reuse it EXACTLY, " +
                "character for character. Only invent a title for a story that matches no anchor.",
            },
            matches_anchor: {
              type: "boolean",
              description: "True when `title` is one of the anchor titles supplied in the context.",
            },
            company: { type: "string", description: "The employer the story happened at, e.g. 'Oscar' or 'Garner'." },
            competency: {
              type: "string",
              description: "The single competency this is the strongest answer for — how it gets found under pressure.",
            },
            variant_titles: {
              type: "array",
              items: { type: "string" },
              description:
                "Every title this story has previously been filed under, copied EXACTLY as given — they are the key " +
                "the assembly pass uses to find this cluster's material, and they become aliases afterwards. A " +
                "paraphrase here both starves the assembly and resurrects the duplicate later.",
            },
            source_note: {
              type: "string",
              description: "Where the material came from, e.g. 'merged from 3 Cityblock/EvolutionIQ syntheses'.",
            },
          },
          required: ["title", "matches_anchor", "competency", "variant_titles"],
        },
      },
      unmatched_anchors: {
        type: "array",
        items: { type: "string" },
        description:
          "Anchor titles with no material anywhere in the input. These are the stories the candidate says they tell " +
          "but has never written down — the highest-value gap in the library.",
      },
      coverage_notes: {
        type: "array",
        items: { type: "string" },
        description: "What the consolidated library is thin on: competencies with no strong story, over-reliance on one employer, stale material.",
      },
    },
    required: ["clusters"],
  },
};

const CONSOLIDATE_STORY_TOOL = {
  name: "report_consolidated_story",
  description:
    "Assemble ONE story from every telling of it, taking the best version of each STAR component across the variants.",
  input_schema: {
    type: "object",
    properties: {
      competency: {
        type: "string",
        description: "The single competency this is the strongest answer for — how it gets found under pressure.",
      },
      company: { type: "string", description: "The employer the story happened at, e.g. 'Oscar' or 'Garner'." },
      best_for: { type: "string", description: "Secondary competencies / question types it also answers." },
      situation: { type: "string", description: "The best situation across the variants — stakes visible, no preamble." },
      task: { type: "string", description: "What the candidate specifically owned. Not what the team owned." },
      action: { type: "string", description: "The best action across the variants — the actual mechanism, decisions and tradeoffs included." },
      result: { type: "string", description: "The best result across the variants. Quantified if ANY variant quantified it — carry the number over." },
      earned_secret: {
        type: "string",
        description:
          "The insight only this candidate could have, from having lived it. Omit rather than invent: an " +
          "absent secret is the finding, and a manufactured one fails the moment it's probed.",
      },
      strength: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description:
          "How strong the CONSOLIDATED story is: 5 = quantified, differentiated, ready to tell. 3 = complete " +
          "but interchangeable. Do not inflate because several variants exist — four vague tellings is still vague.",
      },
      sharpen: {
        type: "string",
        description:
          "The one thing to fix before telling it. Usually a missing number. Omit only if it's genuinely ready.",
      },
    },
    required: ["strength"],
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

/** get_decode_context — the posting-scoped read behind `decode`. */
type DecodeContext = {
  success: boolean;
  error?: string;
  posting: {
    id: string;
    title: string;
    organization_name: string;
    location: string | null;
    remote_policy: string | null;
    requirements: string[] | null;
    nice_to_haves: string[] | null;
    notes: string | null;
    /** The stored posting body. Null when intake never captured it. */
    jd_text: string | null;
    role_type: string | null;
  };
  company_intel: { growth_stage: string | null } | null;
  fit: { alignment: number | null; summary: string | null; spikes: string[] | null; gaps: string[] | null } | null;
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

/**
 * The posting-scoped seed, for the stages that run before any round exists.
 *
 * decode used to build its prompt from PrepContext, which meant it couldn't run
 * until a round was scheduled and a prep session started. A job description is
 * decodable the moment the role is intaked — which is when it's useful, because
 * it tells you which stories to go build.
 */
function postingSeed(ctx: DecodeContext): string {
  const p = ctx.posting;
  const parts: string[] = [`Role: ${p.title} @ ${p.organization_name}`];
  if (p.location || p.remote_policy) {
    parts.push(`Location: ${[p.location, p.remote_policy].filter(Boolean).join(" · ")}`);
  }
  if (p.role_type) parts.push(`Role track (judged from the JD): ${p.role_type}`);
  if (ctx.company_intel?.growth_stage) parts.push(`Company stage: ${ctx.company_intel.growth_stage}`);
  // The résumé-side read of the same JD. Included so decode's coverage verdict
  // and the fit panel's spikes/gaps don't contradict each other on one screen.
  if (ctx.fit?.summary) parts.push(`Candidate fit summary: ${ctx.fit.summary}`);
  if (ctx.fit?.spikes?.length) parts.push(`Candidate strengths: ${ctx.fit.spikes.join("; ")}`);
  if (ctx.fit?.gaps?.length) parts.push(`Candidate gaps: ${ctx.fit.gaps.join("; ")}`);
  if (p.requirements?.length) parts.push(`Requirements captured at intake: ${p.requirements.join("; ")}`);
  if (p.notes) parts.push(`Intake notes:\n${p.notes}`);
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

/**
 * A forced tool call that ran out of output budget still comes back as a
 * `tool_use` block — with whatever fields fit and the rest silently missing. So
 * `findToolUse` succeeding is not the same as the model finishing, and a
 * consolidated story truncated mid-`result` is exactly the material this pass
 * exists to preserve. Check the stop reason before trusting the input.
 */
function hitTokenCeiling(data: { stop_reason?: string }) {
  return data?.stop_reason === "max_tokens";
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
 * The ported command stages: one forced-tool call over the prep + coaching
 * context, persisted as a coaching_artifact. Only the persona, tool, and
 * fragment set differ.
 *
 * `decode` and `progress` keep their entries here for the persona/tool/budget
 * but are dispatched separately — they're scoped to a posting and to the
 * candidate respectively, so neither goes through the per-round prep session.
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

    const { interview_id, stage, action, message, draft_answer, jd_text, job_posting_id, cluster } =
      await req.json();
    if (!stage) return json({ success: false, error: "stage required" }, 400);

    // Three scopes, and only the per-round one needs an interview_id:
    //   per-candidate  progress, consolidate_*  — reviews the whole search
    //   per-role       decode                   — a JD belongs to a posting
    //   per-round      everything else
    const SCOPELESS = ["progress", "consolidate_stories", "consolidate_cluster"];
    const needsInterview = !SCOPELESS.includes(stage) && stage !== "decode";
    if (needsInterview && !interview_id) {
      return json({ success: false, error: "interview_id required" }, 400);
    }
    if (stage === "decode" && !job_posting_id) {
      return json({ success: false, error: "decode needs a job_posting_id — it's scoped to the role, not the round" }, 400);
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

    // ---- decode: per-ROLE, so it runs at intake, before any round exists ----
    // Once per job by construction: the artifact is keyed on the posting
    // (migration 026), so a second call overwrites rather than adding a row —
    // and the caller checks for an existing one before spending the tokens.
    if (stage === "decode") {
      const cfg = ARTIFACT_STAGES.decode;
      const { data: dctx, error: dErr } = await admin.rpc("get_decode_context", {
        p_job_posting_id: job_posting_id,
        p_user_id: userId,
      });
      if (dErr) throw dErr;
      const decodeCtx = dctx as DecodeContext;
      if (!decodeCtx?.success) return json({ success: false, error: decodeCtx?.error ?? "posting not found" }, 404);

      // Prefer the JD the caller passed (a fresh paste is more current than a
      // stored one), then the body intake captured. Requirements alone are too
      // thin: decode's whole job is reading the wording, and a bullet list
      // compressed at intake has already lost it.
      const body = (typeof jd_text === "string" && jd_text.trim()) || decodeCtx.posting.jd_text;
      if (!body) {
        return json({
          success: false,
          error: "no job description stored for this role — paste it once and it's kept for future re-runs",
        }, 400);
      }

      // A pasted JD is worth keeping: it's what makes the NEXT decode (and the
      // regenerate button) work without asking again. Best-effort — a failed
      // save shouldn't cost the decode the user just paid for.
      if (typeof jd_text === "string" && jd_text.trim() && jd_text.trim() !== decodeCtx.posting.jd_text) {
        try {
          await admin.rpc("set_posting_jd_text", {
            p_job_posting_id: job_posting_id,
            p_jd_text: jd_text,
            p_user_id: userId,
          });
        } catch (e) {
          console.error("set_posting_jd_text failed (decode still ran):", (e as Error).message);
        }
      }

      const extra = isLevelFive(coach) ? ["challenge_lenses"] : [];
      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: cfg.maxTokens,
        system: systemBlocks(
          `${cfg.persona}\n\n${coachGuidance("decode", extra)}`,
          `${postingSeed(decodeCtx)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [cfg.tool],
        tool_choice: { type: "tool", name: cfg.toolName },
        messages: [{ role: "user", content: `=== JOB DESCRIPTION ===\n${body}\n\nCall ${cfg.toolName}.` }],
      });
      const toolUse = findToolUse(data, cfg.toolName);
      if (!toolUse) return json({ success: false, error: "decode did not return a result — try again" }, 502);

      const { data: saved, error: saveErr } = await admin.rpc("save_coaching_artifact", {
        p_kind: "decode",
        p_content: toolUse.input,
        p_interview_id: null,
        p_job_posting_id: job_posting_id,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(saved);
    }

    // ---- consolidate_stories / consolidate_cluster: candidate-scoped, and ---
    // the only stages that propose rather than persist.
    //
    // Merging stories destroys material — the wrong merge loses the one telling
    // that had the number in it. So these return clusters for review and the
    // client applies the accepted ones through upsert_story / merge_stories.
    // Every other stage can afford to write directly because a bad artifact is
    // just regenerated.
    //
    // Two passes (see CONSOLIDATE_PLAN_TOOL for why): `consolidate_stories`
    // decides what the stories are, `consolidate_cluster` writes one of them.
    // Both read the same material, so they share the load below.
    if (stage === "consolidate_stories" || stage === "consolidate_cluster") {
      const { data: input, error: inErr } = await admin.rpc("get_story_consolidation_input", {
        p_user_id: userId,
      });
      if (inErr) throw inErr;
      const material = input as {
        anchors: Array<{ title: string; company?: string; competency?: string; has_star?: boolean }>;
        banked: Array<Record<string, unknown>>;
        synthesized: Array<{ organization_name: string; role_title: string; interview_type: string | null; synthesized_at: string; story: Record<string, unknown> }>;
      };

      const tellings = material.synthesized ?? [];
      const banked = material.banked ?? [];
      if (tellings.length === 0 && banked.length === 0) {
        return json({
          success: false,
          error: "nothing to consolidate — no synthesized prep sheets and an empty storybank. Run a prep synthesis first, or add stories in conversation.",
        }, 400);
      }

      const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
      const clip = (v: unknown, n: number) => {
        const s = String(v ?? "").replace(/\s+/g, " ").trim();
        return s.length > n ? `${s.slice(0, n)}…` : s;
      };

      // The full text of one telling — what the assembly pass reads. Every
      // field, uncut, including the narrative: at a handful of tellings that's
      // cheap, and the number this pass exists to rescue is often only in the
      // narrative.
      const fullTelling = (t: typeof tellings[number], i: number) => {
        const s = t.story as Record<string, unknown>;
        return (
          `--- telling ${i + 1} · ${t.organization_name} ${t.role_title ? `(${t.role_title})` : ""} ` +
          `${t.interview_type ?? ""} · synthesized ${(t.synthesized_at ?? "").slice(0, 10)}\n` +
          `title: ${s.title ?? "(untitled)"}\n` +
          `competency: ${s.competency ?? "-"}\n` +
          `situation: ${s.situation ?? "-"}\n` +
          `task: ${s.task ?? "-"}\n` +
          `action: ${s.action ?? "-"}\n` +
          `result: ${s.result ?? "-"}\n` +
          (s.best_for ? `best_for: ${s.best_for}\n` : "") +
          (s.story ? `narrative: ${s.story}\n` : "")
        );
      };

      const bankedLine = (s: Record<string, unknown>) => {
        const star = [s.situation, s.task, s.action, s.result].filter(Boolean).join(" / ");
        return (
          `- "${s.title}"${s.is_anchor ? " [ANCHOR]" : ""}${s.company ? ` [${s.company}]` : ""} ` +
          `[${s.competency ?? "uncategorized"}] strength ${s.strength ?? "?"}/5` +
          (star ? `\n  ${star}` : "\n  (no STAR written)") +
          (s.earned_secret ? `\n  earned secret: ${s.earned_secret}` : "") +
          (Array.isArray(s.aliases) && s.aliases.length ? `\n  already absorbed: ${(s.aliases as string[]).join(" | ")}` : "")
        );
      };

      // ---- pass 2: assemble ONE story from just its own tellings ------------
      if (stage === "consolidate_cluster") {
        const want = new Set(
          [cluster?.title, ...(cluster?.variant_titles ?? [])].filter(Boolean).map(norm),
        );
        if (!cluster?.title || want.size === 0) {
          return json({ success: false, error: "consolidate_cluster needs { cluster: { title, variant_titles } }" }, 400);
        }

        // Titles are the join key the plan pass emits. A title it paraphrased
        // finds nothing here, which is why the plan tool leans on copying them
        // character for character.
        const mine = tellings.filter((t) => want.has(norm((t.story as Record<string, unknown>).title)));
        const bankedMine = banked.filter((s) =>
          want.has(norm(s.title)) ||
          (Array.isArray(s.aliases) && (s.aliases as string[]).some((a) => want.has(norm(a)))));

        if (mine.length === 0 && bankedMine.length === 0) {
          return json({
            success: false,
            error: `no material found for "${cluster.title}" — none of its variant titles matched a telling. Re-run the plan.`,
          }, 404);
        }

        // An ANCHOR is a title with nothing behind it until a telling gets filed
        // under it — that's the whole reason set_story_anchors writes STAR-less
        // rows. So a cluster can match material by title and still have no words
        // in it, and asking the model to assemble from nothing gets you a
        // confident empty story with a strength score attached. Say so instead:
        // "you tell this one but have never written it down" is the finding, and
        // it's the same thing the library itself reports for a bare anchor.
        const hasWords = (s: Record<string, unknown>) => Boolean(s.situation || s.task || s.action || s.result);
        if (mine.length === 0 && !bankedMine.some(hasWords)) {
          return json({
            success: true,
            cluster: {
              ...cluster,
              no_material: true,
              sharpen:
                "Nothing written down anywhere — no prep synthesis has ever captured this one. Rehearse a round " +
                "that draws on it, or dictate it in conversation, and consolidation will have something to fold in.",
            },
            telling_count: 0,
          });
        }

        const data = await callClaude(apiKey, {
          model: MODEL,
          max_tokens: 1500,
          system: systemBlocks(
            "You assemble one interview story from every telling of it.\n\n" +
              "The same story has been told many times across many prep sessions, each inventing its own title and " +
              "remembering a different part. Take the sharpest situation, the task as the candidate actually owned " +
              "it, the action with its real mechanism, and the most quantified result available across ALL of them. " +
              "If one telling has the number and three don't, the number carries over — that is the single most " +
              "valuable thing this pass does.\n\n" +
              "Rules that matter more than tidiness:\n" +
              "- Never invent content. If no telling quantified the result, say so in `sharpen` rather than supplying " +
              "a plausible figure — a fabricated number is the one failure mode that destroys credibility in the room.\n" +
              "- Be honest in `strength`. Four vague tellings assemble into one vague story, not a strong one.\n" +
              "- Omit `earned_secret` rather than manufacture one. Its absence is the finding.\n\n" +
              "Call report_consolidated_story.\n\n" +
              coachGuidance("stories"),
            `=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
          ),
          tools: [CONSOLIDATE_STORY_TOOL],
          tool_choice: { type: "tool", name: "report_consolidated_story" },
          messages: [
            {
              role: "user",
              content:
                `=== THE STORY ===\n"${cluster.title}"` +
                `${cluster.company ? ` · ${cluster.company}` : ""}${cluster.competency ? ` · ${cluster.competency}` : ""}\n\n` +
                (bankedMine.length
                  ? `=== ALREADY IN THE STORYBANK ===\n${bankedMine.map(bankedLine).join("\n")}\n\n`
                  : "") +
                `=== EVERY TELLING OF IT (${mine.length}) ===\n` +
                (mine.length ? mine.map(fullTelling).join("\n") : "(none — the storybank entry above is all there is)") +
                "\n\nAssemble it and call report_consolidated_story.",
            },
          ],
        });
        const toolUse = findToolUse(data, "report_consolidated_story");
        if (!toolUse) return json({ success: false, error: `could not assemble "${cluster.title}" — try again` }, 502);
        if (hitTokenCeiling(data)) {
          return json({
            success: false,
            error: `"${cluster.title}" ran past the output budget and came back half-written — try again`,
          }, 502);
        }

        // The plan owns identity (title, aliases, anchor match); this pass owns
        // content. Merge in that order so an assembly that drifted on the title
        // can't fork the cluster the candidate is looking at.
        return json({
          success: true,
          cluster: {
            ...cluster,
            ...(toolUse.input as Record<string, unknown>),
            title: cluster.title,
            matches_anchor: cluster.matches_anchor ?? false,
            variant_titles: cluster.variant_titles ?? [],
            source_note:
              cluster.source_note ??
              `assembled from ${mine.length} telling${mine.length === 1 ? "" : "s"}`,
          },
          telling_count: mine.length,
        });
      }

      // ---- pass 1: decide what the stories are ------------------------------
      // Anchors go in FIRST and are labelled as the candidate's own names. The
      // model reuses them verbatim; everything else is material to be filed
      // under them. That's what stops the library drifting back to
      // model-invented titles on every run.
      const anchorBlock = material.anchors?.length
        ? `=== THE CANDIDATE'S ANCHOR STORIES (${material.anchors.length}) ===\n` +
          "These are the stories they say they keep coming back to. Reuse these titles EXACTLY. File every variant " +
          "you find under the anchor it belongs to, and never merge an anchor into something else.\n" +
          material.anchors
            .map((a) => `- "${a.title}"${a.company ? ` [${a.company}]` : ""}${a.competency ? ` — ${a.competency}` : ""}${a.has_star ? "" : " (no STAR written yet)"}`)
            .join("\n")
        : "=== ANCHOR STORIES ===\n(none declared — cluster on the material alone and title each cluster the way the candidate would refer to it: what happened, where.)";

      // One line per telling, not the whole thing. Recognising that four titles
      // describe one event needs the title, where it happened, and enough of the
      // situation and result to identify it — not the full STAR. Sending the
      // full text here is what made the single-call version output-bound.
      //
      // Clipped generously, though: it's OUTPUT that blew the budget, and the
      // thing this pass has to get right is deciding that a telling titled
      // "Steerage Metric Definition → Product Experimentation" is the anchor
      // called "Steerage dashboard at Oscar". Starve it of situation text and it
      // files that under a new title instead, which is the drift the anchors
      // exist to stop.
      const indexBlock = tellings.length
        ? tellings
            .map((t) => {
              const s = t.story as Record<string, unknown>;
              return (
                `- "${s.title ?? "(untitled)"}" · ${t.organization_name}` +
                `${t.interview_type ? ` ${t.interview_type}` : ""} · ${s.competency ?? "uncategorized"}\n` +
                `  ${clip(s.situation, 320) || "(no situation written)"}` +
                (s.action ? `\n  did: ${clip(s.action, 200)}` : "") +
                (s.result ? `\n  → ${clip(s.result, 160)}` : "")
              );
            })
            .join("\n")
        : "(no synthesized prep sheets)";

      const bankedBlock = banked.length ? banked.map(bankedLine).join("\n") : "(storybank is empty)";

      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 4000,
        system: systemBlocks(
          "You reconcile a candidate's scattered interview stories into one clean library.\n\n" +
            "The same story has been told many times across many prep sessions, and each session invented its own " +
            "title for it. Your job in THIS pass is only to recognise which tellings are the same story. You are " +
            "shown one line per telling — a title, where it happened, and a clipped situation. Do not write the " +
            "stories; a second pass assembles each one with the full text in hand.\n\n" +
            "Rules that matter more than tidiness:\n" +
            "- Cluster on the UNDERLYING EVENT, not on wording. Two tellings of the same Garner steerage work are one " +
            "cluster even if the titles share no words. Two different hard-people-calls at two different companies " +
            "are two clusters even if both are tagged 'conflict'.\n" +
            "- Copy `variant_titles` character for character from the input. They are how the assembly pass finds " +
            "this cluster's material, and they become aliases afterwards; a paraphrase both starves the assembly and " +
            "silently resurrects the duplicate on the next run.\n" +
            "- Every telling belongs to exactly one cluster. A story you can't place still gets its own cluster — " +
            "dropping it loses the material.\n" +
            "- **Anchors are where the tellings go.** An anchor is the candidate's own name for a story they keep " +
            "telling, so almost every anchor SHOULD end up with variant titles filed under it. Before you invent a " +
            "title for a cluster, check whether it is one of the anchors described differently — a telling about the " +
            "same company and the same work is that anchor, however little the wording overlaps. Inventing a new " +
            "title for material that belongs to an anchor is the specific failure this pass exists to prevent.\n" +
            "- An anchor with genuinely no material anywhere goes in `unmatched_anchors` — NOT into a cluster with an " +
            "empty `variant_titles`. A cluster with no variants and no banked STAR has nothing to assemble, and the " +
            "candidate ends up looking at a story with a title and no words in it.\n\n" +
            "Call report_consolidation_plan.\n\n" +
            coachGuidance("stories"),
          `=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [CONSOLIDATE_PLAN_TOOL],
        tool_choice: { type: "tool", name: "report_consolidation_plan" },
        messages: [
          {
            role: "user",
            content:
              `${anchorBlock}\n\n=== ALREADY IN THE STORYBANK ===\n${bankedBlock}\n\n` +
              `=== EVERY TELLING FOUND ACROSS ${tellings.length} PREP SYNTHES${tellings.length === 1 ? "IS" : "ES"} ===\n${indexBlock}\n\n` +
              "Group all of it and call report_consolidation_plan.",
          },
        ],
      });
      const toolUse = findToolUse(data, "report_consolidation_plan");
      if (!toolUse) return json({ success: false, error: "consolidation did not return a plan — try again" }, 502);
      if (hitTokenCeiling(data)) {
        return json({
          success: false,
          error: "the plan ran past the output budget and came back with only some of your stories — try again",
        }, 502);
      }

      // Nothing persisted: the client assembles each cluster, shows it, and
      // applies what the candidate accepts.
      return json({
        success: true,
        proposal: toolUse.input,
        input_counts: { tellings: tellings.length, banked: banked.length, anchors: material.anchors?.length ?? 0 },
      });
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

    // ---- the per-round command stages: concerns / questions / hype ----------
    // decode used to live here. It doesn't any more: it's keyed to the posting
    // and handled above, because a JD is a property of the role and decoding it
    // once per round was the same model call repeated N times.
    if (stage in ARTIFACT_STAGES) {
      const key = stage as keyof typeof ARTIFACT_STAGES;
      const cfg = ARTIFACT_STAGES[key];
      const extra = isLevelFive(coach) ? ["challenge_lenses"] : [];

      const data = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: cfg.maxTokens,
        system: systemBlocks(
          `${cfg.persona}\n\n${coachGuidance(key, extra)}`,
          `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}\n\n=== COACHING CONTEXT ===\n${coachSeed(coach)}${directnessNote(coach)}`,
        ),
        tools: [cfg.tool],
        tool_choice: { type: "tool", name: cfg.toolName },
        messages: [{ role: "user", content: `Call ${cfg.toolName} for this interview.` }],
      });
      const toolUse = findToolUse(data, cfg.toolName);
      if (!toolUse) return json({ success: false, error: `${key} did not return a result — try again` }, 502);

      const { data: saved, error: saveErr } = await admin.rpc("save_coaching_artifact", {
        p_kind: cfg.kind,
        p_content: toolUse.input,
        p_interview_id: interview_id,
        p_job_posting_id: null,
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
