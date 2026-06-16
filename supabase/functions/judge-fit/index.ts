/**
 * judge-fit — the AI judge behind the dashboard's "Run AI judge" button.
 *
 * For a given job posting, scores EVERY one of the user's resume variants
 * against the JD with Claude, then persists the read via save_role_fit (which
 * also lifts job_postings.experience_alignment to the best fit, so the priority
 * force-ranking stops tapping out at the neutral 0.5 default). Returns the fresh
 * get_role_fit payload so the page can re-render immediately.
 *
 * Why a separate edge function (not the MCP / not SQL): it makes an outbound
 * Anthropic call with a secret key, which must stay server-side.
 *
 * Auth model: the caller's JWT (forwarded by supabase.functions.invoke)
 * identifies the user; all DB work uses the service role but is scoped to that
 * user_id, and the posting is verified to belong to them first.
 *
 * Secrets (set with `supabase secrets set`):
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

// Structured-output tool: forces Claude to return exactly these fields.
const FIT_TOOL = {
  name: "report_fit",
  description:
    "Report how well a single resume fits a specific job description. Be concrete and specific to THIS resume and THIS JD — never generic.",
  input_schema: {
    type: "object",
    properties: {
      alignment: {
        type: "number",
        description:
          "0..1 fit of this resume vs the JD. 1.0 = clearly clears the bar on the core requirements; 0.5 = a stretch; below 0.4 = weak match.",
      },
      summary: {
        type: "string",
        description: "2-4 sentence read of this resume against the JD.",
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
    required: ["alignment", "summary", "spikes", "gaps", "tweaks"],
  },
};

function jdContext(p: Record<string, unknown>): string {
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

async function judgeOne(
  apiKey: string,
  jd: string,
  resumeLabel: string,
  resumeText: string,
): Promise<{
  alignment: number;
  summary: string;
  spikes: string[];
  gaps: string[];
  tweaks: Array<{ section?: string; suggestion: string; rationale?: string }>;
}> {
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
      tools: [FIT_TOOL],
      tool_choice: { type: "tool", name: "report_fit" },
      messages: [
        {
          role: "user",
          content:
            `You are screening one candidate resume against one job description, the way a sharp hiring manager who also knows how ATS keyword screens work would. Judge fit honestly — do not inflate.\n\n` +
            `=== JOB DESCRIPTION ===\n${jd}\n\n` +
            `=== RESUME (variant: ${resumeLabel}) ===\n${resumeText}\n\n` +
            `Call report_fit with your assessment. Keep spikes/gaps/tweaks specific to this resume and this JD.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic returned no tool_use block");
  return toolUse.input;
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

    // Identify the caller from their JWT.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ success: false, error: "invalid auth" }, 401);
    const userId = userData.user.id;

    const { job_posting_id, resume_id } = await req.json();
    if (!job_posting_id) return json({ success: false, error: "job_posting_id required" }, 400);

    // Service-role client for the privileged reads/writes, scoped to this user.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: posting, error: postErr } = await admin
      .from("job_postings")
      .select("id, title, url, location, remote_policy, salary_min, salary_max, requirements, nice_to_haves, notes")
      .eq("id", job_posting_id)
      .eq("user_id", userId)
      .single();
    if (postErr || !posting) return json({ success: false, error: "posting not found" }, 404);

    // Judge all resumes by default, or just one when resume_id is given (used to
    // score a newly added resume against a subset of roles without re-spending
    // on the others).
    let resumeQuery = admin.from("resumes").select("id, label, resume_text").eq("user_id", userId);
    if (resume_id) resumeQuery = resumeQuery.eq("id", resume_id);
    const { data: resumes, error: resErr } = await resumeQuery;
    if (resErr) throw resErr;

    const usable = (resumes ?? []).filter((r) => r.resume_text && r.resume_text.trim().length > 0);
    if (usable.length === 0)
      return json({ success: false, error: "no resume to judge — add one on the Resumes page first" }, 400);

    const jd = jdContext(posting);

    // Judge each resume, then persist. Done in parallel; one failure shouldn't
    // sink the others.
    const results = await Promise.allSettled(
      usable.map(async (r) => {
        const fit = await judgeOne(apiKey, jd, r.label, r.resume_text!);
        const { error: saveErr } = await admin.rpc("save_role_fit", {
          p_job_posting_id: job_posting_id,
          p_resume_id: r.id,
          p_alignment: fit.alignment,
          p_summary: fit.summary,
          p_spikes: fit.spikes,
          p_gaps: fit.gaps,
          p_tweaks: fit.tweaks,
          p_model: MODEL,
          p_user_id: userId,
        });
        if (saveErr) throw saveErr;
        return r.label;
      }),
    );

    const failed = results.filter((x) => x.status === "rejected");
    if (failed.length === usable.length) {
      const reason = (failed[0] as PromiseRejectedResult).reason;
      return json({ success: false, error: `judging failed: ${reason?.message ?? reason}` }, 502);
    }

    // Return the fresh fit payload so the page re-renders with scores.
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
