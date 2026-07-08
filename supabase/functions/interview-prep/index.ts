/**
 * interview-prep — the AI-heavy stages behind the Interview Prep page.
 *
 * Round two of docs/checklist-feature-discovery.md Feature 3: the static
 * assembly card (InterviewPrep.tsx) already surfaces company/fit/interviewer
 * data the app has; this function is the "AI-written prep brief" it stubbed.
 * One function, dispatched on `stage` in the request body, so there's a
 * single deploy/secret config instead of four:
 *
 *   stage: "research"   — web-searches the named person/people + summarizes
 *                          the role's real functions. Mirrors judge-growth's
 *                          use of the server-side web_search tool.
 *   stage: "chat"        action: "reply"    — continues the live mock
 *                          interview, in character as the researched
 *                          interviewer(s).
 *                        action: "feedback" — an out-of-character critique.
 *                          With `draft_answer`: workshop mode — critiques text
 *                          the candidate hasn't sent yet, against the most
 *                          recent question. Nothing is persisted, so they can
 *                          iterate on wording freely. Without it: critiques
 *                          the last committed answer, logged to the transcript
 *                          (the existing "Get feedback on my last answer").
 *   stage: "synthesize" — reads the whole session (intake + research +
 *                          transcript) into a closing bulleted prep sheet:
 *                          stories to tell, competencies to focus on,
 *                          questions to ask.
 *
 * Same skeleton as judge-fit/judge-growth/synthesize-feedback: CORS, JWT ->
 * user_id via the anon client, service-role client scoped to that user,
 * forced-tool-choice Anthropic call, persist via RPC, return the fresh
 * get_interview_prep_session payload so the page re-renders in one round trip.
 *
 * Secrets (already set for the other judges — none new needed):
 *   ANTHROPIC_API_KEY   — required
 *   JUDGE_MODEL         — optional, defaults to claude-sonnet-4-6
 * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.
 */

import { createClient } from "@supabase/supabase-js";

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

const FEEDBACK_TOOL = {
  name: "report_feedback",
  description: "Critique the candidate's last answer against the question it responded to, out of character.",
  input_schema: {
    type: "object",
    properties: {
      rating: { type: "string", enum: ["strong", "solid", "needs_work", "weak"] },
      what_worked: { type: "array", items: { type: "string" } },
      what_to_improve: { type: "array", items: { type: "string" } },
      suggested_rewrite: { type: "string", description: "Optional: a tightened version of the answer." },
    },
    required: ["rating", "what_worked", "what_to_improve"],
  },
};

const SYNTHESIS_TOOL = {
  name: "report_prep_summary",
  description:
    "Synthesize the full prep session (research + mock-interview transcript + any coach feedback) into a final " +
    "bulleted prep sheet the candidate can skim right before walking in.",
  input_schema: {
    type: "object",
    properties: {
      stories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            story: { type: "string", description: "The STAR-shaped story to tell, specific and concrete." },
            best_for: { type: "string", description: "Which competency or question type this story best answers." },
          },
          required: ["title", "story"],
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
    required: ["stories", "competencies", "questions_to_ask"],
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
  interview: { interview_type: string | null; scheduled_at: string | null };
  role: { title: string; organization_name: string };
  company_intel: { growth_stage: string | null };
  fit: { alignment: number | null; summary: string | null; spikes: string[] | null; gaps: string[] | null } | null;
  interviewer: { name: string; title: string | null } | null;
  session: Session | null;
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

function findToolUse(data: { content?: Array<{ type: string; name?: string; input?: unknown }> }, name: string) {
  return (data.content ?? []).reverse().find((b) => b.type === "tool_use" && b.name === name);
}

// Shared by both feedback paths (committed-answer and draft-workshop) — the
// coach persona is the same either way, only what happens to the result differs.
async function critiqueAnswer(apiKey: string, prep: PrepContext, question: string | null, answer: string) {
  const data = await callClaude(apiKey, {
    model: MODEL,
    max_tokens: 1200,
    system:
      "You are an interview coach, stepping OUT of character to critique one answer. Be specific and honest, " +
      "not just encouraging. Call report_feedback.",
    tools: [FEEDBACK_TOOL],
    tool_choice: { type: "tool", name: "report_feedback" },
    messages: [
      {
        role: "user",
        content:
          `${contextSeed(prep)}\n\n` +
          `${question ? `Question asked: ${question}\n\n` : ""}` +
          `Candidate's answer: ${answer}`,
      },
    ],
  });
  const toolUse = findToolUse(data, "report_feedback");
  return toolUse ? (toolUse.input as Record<string, unknown>) : null;
}

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

    const { interview_id, stage, action, message, draft_answer } = await req.json();
    if (!interview_id) return json({ success: false, error: "interview_id required" }, 400);
    if (!stage) return json({ success: false, error: "stage required" }, 400);

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
        system:
          "You research the people and role behind a job interview so a candidate can prep. Use web_search to find " +
          "each named person's public background (current/prior roles, focus areas) — disambiguate using their title " +
          "and company. If search turns up too little on someone, say so plainly rather than guessing. Then call " +
          "report_interview_research.",
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
        // read as your real reply and advancing the interview.
        if (typeof draft_answer === "string" && draft_answer.trim()) {
          const priorQuestion = [...transcript].reverse().find((m) => m.kind === "interviewer");
          const feedback = await critiqueAnswer(apiKey, prep, priorQuestion?.content ?? null, draft_answer);
          if (!feedback) return json({ success: false, error: "coach did not return feedback — try again" }, 502);
          return json({ success: true, feedback, question: priorQuestion?.content ?? null });
        }

        // Committed-answer mode: critique the last answer you actually sent,
        // logged to the transcript (the "Get feedback on my last answer" button).
        const lastUser = [...transcript].reverse().find((m) => m.kind === "user");
        if (!lastUser) return json({ success: false, error: "no answer yet to give feedback on" }, 400);
        const priorQuestion = [...transcript].reverse().find((m) => m.kind === "interviewer" && m.created_at < lastUser.created_at);

        const feedback = await critiqueAnswer(apiKey, prep, priorQuestion?.content ?? null, lastUser.content);
        if (!feedback) return json({ success: false, error: "coach did not return feedback — try again" }, 502);

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
        system:
          "You are role-playing as the interviewer(s) in a mock job interview, to help a candidate rehearse. Stay in " +
          "character as a real person conducting this specific interview — ask one realistic question at a time, " +
          "react briefly to the candidate's last answer the way an attentive interviewer would (no scoring, no meta " +
          "commentary), then ask the next question or a natural follow-up. Draw questions from the interview type and " +
          "the researched role/people background below. Keep each turn to a few sentences.\n\n" +
          `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}` +
          (feedbackCount > 0 ? `\n\n(The candidate has requested coach feedback ${feedbackCount} time(s) so far — stay in character regardless.)` : ""),
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
        system:
          "You close out an interview prep session. Read the role/research context, the mock-interview transcript, " +
          "and any coach feedback, then call report_prep_summary with a tight, specific closing sheet — real stories " +
          "grounded in what the candidate actually said (not generic advice), the competencies this interview is " +
          "really testing, and sharp questions worth asking back.",
        tools: [SYNTHESIS_TOOL],
        tool_choice: { type: "tool", name: "report_prep_summary" },
        messages: [
          {
            role: "user",
            content:
              `${contextSeed(prep)}\n\n${researchSeed(prep.session.research)}\n\n` +
              `=== MOCK INTERVIEW TRANSCRIPT ===\n${transcriptText || "(no rehearsal turns yet)"}\n\n` +
              "Call report_prep_summary.",
          },
        ],
      });
      const toolUse = findToolUse(data, "report_prep_summary");
      if (!toolUse) return json({ success: false, error: "synthesis did not return a summary — try again" }, 502);

      const { data: fresh, error: saveErr } = await admin.rpc("save_interview_prep_synthesis", {
        p_interview_id: interview_id,
        p_synthesis: toolUse.input,
        p_model: MODEL,
        p_user_id: userId,
      });
      if (saveErr) throw saveErr;
      return json(fresh);
    }

    return json({ success: false, error: `unknown stage "${stage}"` }, 400);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
