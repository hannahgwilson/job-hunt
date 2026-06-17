/**
 * synthesize-feedback — the AI judge behind the Resumes tab's "Synthesize"
 * button.
 *
 * judge-fit produces one set of tweaks per (resume × role). After a few roles
 * that's a wall of overlapping, differently-worded suggestions. This function
 * reads EVERY role_fit judgement for one resume, makes a single Claude call that
 * clusters the tweaks/gaps into a handful of themes, ranks them by value, and
 * caches the result via save_resume_synthesis. Returns the fresh
 * get_resume_feedback payload so the panel re-renders with the synthesis.
 *
 * Why a separate edge function (not the MCP / not SQL): it makes an outbound
 * Anthropic call with a secret key, which must stay server-side. Same skeleton
 * as judge-fit (CORS, JWT→user_id, service-role client scoped to user_id,
 * forced tool_choice, persist-RPC, return fresh value).
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

// Structured-output tool: forces Claude to return ranked, bucketed themes.
const SYNTH_TOOL = {
  name: "report_synthesis",
  description:
    "Synthesize many per-role resume critiques into a short, ranked list of themed edits. Merge suggestions that say the same thing in different words. Rank by value: an edit that recurs across many roles, or unblocks a high-fit role, ranks above a one-off.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One sentence: the single highest-value change to make to this resume.",
      },
      themes: {
        type: "array",
        description: "3-7 themed buckets of edits, ordered highest-value first.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short label for the bucket, e.g. 'Quantify impact with metrics'." },
            category: {
              type: "string",
              enum: ["Summary", "Experience", "Skills & keywords", "Structure & formatting", "Other"],
              description: "Coarse resume area this bucket touches.",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Value of making this change, factoring how often it recurred and the fit of the roles it came from.",
            },
            role_count: {
              type: "integer",
              description: "How many distinct roles asked for something in this bucket.",
            },
            recommendation: {
              type: "string",
              description: "The concrete consolidated edit to make — specific and actionable, not generic advice.",
            },
            rationale: {
              type: "string",
              description: "Why this is worth doing (human reviewer + ATS), 1-2 sentences.",
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "The role names this theme draws from (e.g. 'Senior AI Engineer · Anthropic').",
            },
          },
          required: ["title", "category", "priority", "role_count", "recommendation"],
        },
      },
    },
    required: ["headline", "themes"],
  },
};

type RoleFitRow = {
  job_posting_id: string;
  alignment: number | null;
  summary: string | null;
  spikes: string[] | null;
  gaps: string[] | null;
  tweaks: Array<{ section?: string; suggestion: string; rationale?: string }> | null;
  job_postings: { title: string | null; organizations: { name: string | null } | null } | null;
};

// Render every judged role into a compact block the model can cluster over.
function feedbackContext(rows: RoleFitRow[]): string {
  return rows
    .map((r, i) => {
      const role = `${r.job_postings?.title ?? "(untitled)"} · ${r.job_postings?.organizations?.name ?? "?"}`;
      const pct = r.alignment == null ? "?" : `${Math.round(r.alignment * 100)}%`;
      const parts: string[] = [`[Role ${i + 1}] ${role} (fit ${pct})`];
      if (r.gaps?.length) parts.push(`Gaps: ${r.gaps.join("; ")}`);
      const tw = (r.tweaks ?? [])
        .map((t) => `- ${t.section ? `(${t.section}) ` : ""}${t.suggestion}${t.rationale ? ` — ${t.rationale}` : ""}`)
        .join("\n");
      if (tw) parts.push(`Proposed tweaks:\n${tw}`);
      return parts.join("\n");
    })
    .join("\n\n");
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

    const { resume_id } = await req.json();
    if (!resume_id) return json({ success: false, error: "resume_id required" }, 400);

    // Service-role client for the privileged reads/writes, scoped to this user.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: resume, error: resErr } = await admin
      .from("resumes")
      .select("id, label")
      .eq("id", resume_id)
      .eq("user_id", userId)
      .single();
    if (resErr || !resume) return json({ success: false, error: "resume not found" }, 404);

    // Every judged role for this resume, with its posting/org for labels.
    const { data: rows, error: rowsErr } = await admin
      .from("role_fit")
      .select("job_posting_id, alignment, summary, spikes, gaps, tweaks, job_postings:job_posting_id ( title, organizations:organization_id ( name ) )")
      .eq("resume_id", resume_id)
      .eq("user_id", userId)
      .not("alignment", "is", null);
    if (rowsErr) throw rowsErr;

    const judged = (rows ?? []) as unknown as RoleFitRow[];
    if (judged.length === 0)
      return json({ success: false, error: "no judge feedback yet — score this resume against some roles first" }, 400);

    const ctx = feedbackContext(judged);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Generous: the themes array draws on every judged role, so a tight cap
        // truncates the tool output mid-array (headline lands, themes is cut off
        // → undefined → the save RPC fires without p_themes). 8000 clears it.
        max_tokens: 8000,
        tools: [SYNTH_TOOL],
        tool_choice: { type: "tool", name: "report_synthesis" },
        messages: [
          {
            role: "user",
            content:
              `You are a sharp resume coach. Below is feedback several AI judges gave on ONE resume (variant: ${resume.label}), each scoring it against a different job description. ` +
              `Synthesize it into a short, prioritized plan: cluster overlapping suggestions into themes, merge ones that mean the same thing, and rank by value — recurring asks and edits that unblock high-fit roles come first. Be specific to what's actually in this feedback; do not invent generic advice.\n\n` +
              `=== PER-ROLE FEEDBACK (${judged.length} roles) ===\n${ctx}\n\n` +
              `Call report_synthesis with the ranked themes.`,
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
    const out = toolUse.input as { headline?: string; themes?: unknown[] };

    // Guard: a max_tokens truncation leaves themes missing/partial. Fail with a
    // clear reason instead of calling save_resume_synthesis without p_themes
    // (which surfaces as an opaque "could not find function" from PostgREST).
    if (!Array.isArray(out.themes) || out.themes.length === 0) {
      return json({
        success: false,
        error: data.stop_reason === "max_tokens"
          ? "synthesis was cut off before the themes were complete (too much feedback for one pass) — try again"
          : "Anthropic returned no themes",
      }, 502);
    }

    const { error: saveErr } = await admin.rpc("save_resume_synthesis", {
      p_resume_id: resume_id,
      p_themes: out.themes,
      p_headline: out.headline,
      p_source_count: judged.length,
      p_model: MODEL,
      p_user_id: userId,
    });
    if (saveErr) throw saveErr;

    // Return the fresh feedback payload (roles + the synthesis we just cached).
    const { data: fresh, error: freshErr } = await admin.rpc("get_resume_feedback", {
      p_resume_id: resume_id,
      p_user_id: userId,
    });
    if (freshErr) throw freshErr;

    return json(fresh);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
