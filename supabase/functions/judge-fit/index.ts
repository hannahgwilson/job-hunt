/**
 * judge-fit — the AI judge behind the dashboard's "Run AI judge" button.
 *
 * For a given job posting, scores EVERY one of the user's resume variants
 * against the JD with Claude, then persists the read via save_role_fit (which
 * also lifts job_postings.experience_alignment to the best fit, so the priority
 * force-ranking stops tapping out at the neutral 0.5 default). Returns the fresh
 * get_role_fit payload so the page can re-render immediately.
 *
 * Scoring is by ADJACENCY, not keyword matching: the model tiers each JD
 * requirement Identical / Adjacent / Aware / Gap (so a Looker résumé earns credit
 * against a Tableau JD, but a genuine gap stays a gap) and derives `alignment` as
 * the importance-weighted average of that per-requirement table — which is itself
 * persisted (role_fit.requirement_scores) so the score is defensible. The persona,
 * tool schema, and tiering rules live in ./prompt.ts (shared with harness/run.ts
 * so the tuning harness exercises the real prompt); the framework is specified in
 * /resume-scoring-prompt-instructions.md.
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
import { buildFitMessages, buildFitSystem, FIT_TOOL, type FitResult, jdContext } from "./prompt.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

async function judgeOne(
  apiKey: string,
  jd: string,
  resumeLabel: string,
  resumeText: string,
): Promise<FitResult> {
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
      // Stable prefix (cached): tool + persona + this resume; only the JD in the
      // user turn changes per posting. See prompt.ts for the cache rationale.
      system: buildFitSystem(resumeLabel, resumeText),
      tools: [FIT_TOOL],
      tool_choice: { type: "tool", name: "report_fit" },
      messages: buildFitMessages(jd),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  // Observability: confirm the resume prefix is actually being served from cache
  // across a batch. cache_read_input_tokens stays 0 if a silent invalidator crept
  // into the prefix (or the prefix is under the model's min cacheable size).
  const u = data.usage ?? {};
  console.log(
    `judge-fit cache: read=${u.cache_read_input_tokens ?? 0} write=${u.cache_creation_input_tokens ?? 0} uncached=${u.input_tokens ?? 0} (${resumeLabel})`,
  );
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic returned no tool_use block");
  return toolUse.input as FitResult;
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
          p_requirement_scores: fit.requirement_scores,
          p_model: MODEL,
          p_user_id: userId,
        });
        if (saveErr) throw saveErr;
        return fit.role_type;
      }),
    );

    const fulfilled = results.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<string>[];
    if (fulfilled.length === 0) {
      const reason = (results[0] as PromiseRejectedResult).reason;
      return json({ success: false, error: `judging failed: ${reason?.message ?? reason}` }, 502);
    }

    // role_type is a property of the JD (same across resumes) — cache it on the
    // posting so the UI can flag an IC-resume-vs-manager-role track mismatch.
    // Prefer a definite call over "unclear" if the resumes disagreed.
    const roleType = fulfilled.map((x) => x.value).find((t) => t && t !== "unclear")
      ?? fulfilled[0].value;
    if (roleType) {
      await admin.from("job_postings").update({ role_type: roleType })
        .eq("id", job_posting_id).eq("user_id", userId);
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
