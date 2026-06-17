/**
 * judge-career — the AI judge behind the role page's "Judge career move" button.
 *
 * For a given job posting, reads the JD against the user's career_profile (their
 * current seat + what "forward" means to them) and classifies the move as
 * step_up / lateral / step_back, with the per-axis deltas and a rationale. Then
 * persists via save_career_judgment, which lifts job_postings.career_trajectory
 * so compute_priority's force-ranking stops tapping out at the neutral 0.5
 * default. Returns the fresh get_role_fit payload so the page re-renders.
 *
 * Mirrors judge-fit (see that file for the auth model and why it's a separate
 * edge function). career_trajectory is RELATIVE and PERSONAL — without a
 * career_profile the judge can only guess from the title; with it the call is
 * grounded in the user's actual baseline and ambition.
 *
 * Secrets: ANTHROPIC_API_KEY (required), JUDGE_MODEL (optional, defaults sonnet).
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

const DELTA = {
  type: "string",
  enum: ["up", "flat", "down", "n/a"],
};

// Structured-output tool: forces Claude to return exactly these fields.
const CAREER_TOOL = {
  name: "report_career_move",
  description:
    "Classify how a job posting moves the candidate's career relative to their CURRENT seat and what THEY consider forward progress. Be specific to this role and this person — never generic.",
  input_schema: {
    type: "object",
    properties: {
      trajectory: {
        type: "string",
        enum: ["step_up", "lateral", "step_back"],
        description:
          "step_up = clear forward progress on what this person is optimizing for; lateral = sideways (similar level/scope, or a pivot they'd accept); step_back = a regression in level, scope, comp, or off their intended track.",
      },
      confidence: {
        type: "number",
        description: "0..1 confidence in the trajectory call given the evidence available.",
      },
      deltas: {
        type: "object",
        description: "Direction of each axis vs the candidate's current seat.",
        properties: {
          seniority: DELTA,
          scope: DELTA,
          comp: DELTA,
          track: { ...DELTA, description: "IC↔manager track change relative to their target_track." },
          domain: { ...DELTA, description: "Domain fit: up = toward their goal, flat = lateral pivot they'd accept, down = off-track." },
        },
        required: ["seniority", "scope", "comp", "track", "domain"],
      },
      rationale: {
        type: "string",
        description: "2-3 sentences, specific to this role vs their current seat and stated ambition.",
      },
    },
    required: ["trajectory", "confidence", "deltas", "rationale"],
  },
};

function jdContext(p: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push(`Title: ${p.title ?? "(untitled)"}`);
  if (p.location) parts.push(`Location: ${p.location}`);
  if (p.remote_policy) parts.push(`Remote policy: ${p.remote_policy}`);
  if (p.salary_min || p.salary_max) parts.push(`Salary: ${p.salary_min ?? "?"}–${p.salary_max ?? "?"}`);
  if (p.growth_stage) parts.push(`Company stage: ${p.growth_stage}`);
  const reqs = (p.requirements as string[] | null) ?? [];
  if (reqs.length) parts.push(`Requirements:\n- ${reqs.join("\n- ")}`);
  if (p.notes) parts.push(`Notes / JD excerpt:\n${p.notes}`);
  return parts.join("\n\n");
}

// The career_profile, rendered for the prompt. Missing → an honest note so the
// judge knows it's working from the resume alone (and says so in its rationale).
function profileContext(
  cp: Record<string, unknown> | null,
  resumeText: string | null,
): string {
  const parts: string[] = [];
  if (cp) {
    if (cp.current_title || cp.current_level)
      parts.push(`Current: ${cp.current_title ?? ""} (${cp.current_level ?? "level n/a"})`.trim());
    if (cp.current_track) parts.push(`Current track: ${cp.current_track}${cp.current_span ? `, ${cp.current_span} reports` : ""}`);
    if (cp.years_experience) parts.push(`Experience: ${cp.years_experience} years`);
    if (cp.current_comp) parts.push(`Current comp: ~${cp.current_comp}`);
    if (cp.primary_domain) parts.push(`Primary domain: ${cp.primary_domain}`);
    if (cp.target_track) parts.push(`Target track: ${cp.target_track}`);
    if (cp.target_level) parts.push(`Target level: ${cp.target_level}`);
    if (cp.target_comp_floor) parts.push(`Target comp floor: ${cp.target_comp_floor}`);
    const fwd = (cp.forward_means as string[] | null) ?? [];
    if (fwd.length) parts.push(`What "forward" means to them: ${fwd.join(", ")}`);
    const lat = (cp.lateral_domains as string[] | null) ?? [];
    if (lat.length) parts.push(`Domains they'd accept as a lateral pivot: ${lat.join(", ")}`);
    if (cp.notes) parts.push(`Notes: ${cp.notes}`);
  }
  if (parts.length === 0) {
    parts.push(
      "(No career profile set — infer the baseline from the resume below and assume forward = more seniority/scope/comp. Note in your rationale that this read is un-personalized.)",
    );
  }
  if (resumeText && resumeText.trim()) {
    parts.push(`\n=== RESUME (for additional baseline context) ===\n${resumeText.slice(0, 6000)}`);
  }
  return parts.join("\n");
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

    const { job_posting_id } = await req.json();
    if (!job_posting_id) return json({ success: false, error: "job_posting_id required" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: posting, error: postErr } = await admin
      .from("job_postings")
      .select("id, title, location, remote_policy, salary_min, salary_max, requirements, growth_stage, notes")
      .eq("id", job_posting_id)
      .eq("user_id", userId)
      .single();
    if (postErr || !posting) return json({ success: false, error: "posting not found" }, 404);

    const { data: cp } = await admin
      .from("career_profile")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    // Default resume, for baseline context when the profile is thin.
    const { data: resume } = await admin
      .from("resumes")
      .select("resume_text")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const jd = jdContext(posting);
    const profile = profileContext(cp, resume?.resume_text ?? null);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        tools: [CAREER_TOOL],
        tool_choice: { type: "tool", name: "report_career_move" },
        messages: [
          {
            role: "user",
            content:
              `You are a career coach judging whether a role moves a specific candidate forward, sideways, or backward — relative to THEIR current seat and THEIR definition of progress (an IC who wants to stay IC should read a management role as lateral or a step back, not a step up). Judge honestly; do not inflate.\n\n` +
              `=== CANDIDATE ===\n${profile}\n\n` +
              `=== JOB DESCRIPTION ===\n${jd}\n\n` +
              `Call report_career_move with your assessment.`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, error: `Anthropic API ${res.status}: ${body.slice(0, 500)}` }, 502);
    }

    const data = await res.json();
    const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    if (!toolUse) return json({ success: false, error: "Anthropic returned no tool_use block" }, 502);
    const out = toolUse.input as {
      trajectory: string;
      confidence: number;
      deltas: Record<string, string>;
      rationale: string;
    };

    const { error: saveErr } = await admin.rpc("save_career_judgment", {
      p_job_posting_id: job_posting_id,
      p_trajectory: out.trajectory,
      p_confidence: out.confidence,
      p_deltas: out.deltas,
      p_rationale: out.rationale,
      p_model: MODEL,
      p_user_id: userId,
    });
    if (saveErr) throw saveErr;

    const { data: fresh, error: freshErr } = await admin.rpc("get_role_fit", {
      p_job_posting_id: job_posting_id,
      p_user_id: userId,
    });
    if (freshErr) throw freshErr;

    return json(fresh);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
