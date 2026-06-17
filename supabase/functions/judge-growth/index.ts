/**
 * judge-growth — the AI judge behind the role page's "Judge company growth" button.
 *
 * Growth potential is a COMPANY property the JD almost never states, so this
 * judge uses Anthropic's server-side web_search tool to look up the company's
 * funding stage, last round, headcount trend, and momentum, then classifies the
 * growth_stage (seed/early/growth/late/public/unknown). It persists via
 * save_growth_judgment, which caches the signals on the organizations row AND
 * writes the stage to EVERY one of that company's postings owned by the user
 * (one fetch prices many roles). Returns the fresh get_role_fit for the posting
 * the button was clicked from.
 *
 * Mirrors judge-fit / judge-career (same auth model, same persist-then-refetch
 * shape). Unlike those, it makes web_search calls, so it's the costlier judge —
 * the per-company caching is deliberate.
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

// Server-side search tool — Anthropic runs it and feeds results back within the
// same request, so no client round-trip is needed before report_growth fires.
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

const GROWTH_TOOL = {
  name: "report_growth",
  description:
    "Report a company's growth stage and the upside-relevant signals behind it, grounded in what web search surfaced. Use 'unknown' if search is too thin to classify — do not guess a stage.",
  input_schema: {
    type: "object",
    properties: {
      stage: {
        type: "string",
        enum: ["seed", "early", "growth", "late", "public", "unknown"],
        description:
          "seed = pre/seed, raw upside + risk; early = Series A/B, promising; growth = scaling with clear traction; late = late-stage/pre-IPO; public = listed (stable, less upside); unknown = couldn't establish.",
      },
      confidence: { type: "number", description: "0..1 confidence given the evidence found." },
      signals: {
        type: "object",
        description: "The upside-relevant facts found. Omit fields you couldn't establish.",
        properties: {
          funding_stage: { type: "string", description: "e.g. 'Series C'." },
          last_round_date: { type: "string", description: "Approx date of the most recent raise." },
          total_raised: { type: "string", description: "Total raised, e.g. '$210M'." },
          headcount: { type: "string", description: "Approx employee count." },
          headcount_trend: { type: "string", description: "growing fast / flat / shrinking / layoffs." },
          momentum: { type: "array", items: { type: "string" }, description: "Positive signals: new funding, marquee customers, launches." },
          risks: { type: "array", items: { type: "string" }, description: "Negatives: down round, layoffs, leadership churn." },
        },
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "URLs the assessment leans on, so the read is auditable.",
      },
      rationale: { type: "string", description: "2-3 sentences tying the signals to the stage." },
    },
    required: ["stage", "confidence", "rationale"],
  },
};

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

    // Resolve the posting's company (ownership-checked) — growth is judged per-org.
    const { data: posting, error: postErr } = await admin
      .from("job_postings")
      .select("id, organization_id, organizations(id, name, website_url, description)")
      .eq("id", job_posting_id)
      .eq("user_id", userId)
      .single();
    if (postErr || !posting) return json({ success: false, error: "posting not found" }, 404);

    const org = (posting as unknown as {
      organization_id: string;
      organizations: { name: string; website_url: string | null; description: string | null } | null;
    });
    const company = org.organizations;
    if (!company?.name) return json({ success: false, error: "company has no name to research" }, 400);

    const seed = [
      `Company: ${company.name}`,
      company.website_url ? `Website: ${company.website_url}` : "",
      company.description ? `Known blurb: ${company.description}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        tools: [WEB_SEARCH_TOOL, GROWTH_TOOL],
        // Auto so the model can web_search first, THEN call report_growth. Forcing
        // report_growth would block the search; we instruct it to finish there.
        tool_choice: { type: "auto" },
        messages: [
          {
            role: "user",
            content:
              `Assess the GROWTH POTENTIAL of the company below for a job seeker weighing upside. Use web_search to find its funding stage, most recent round (and when), total raised, employee count and whether headcount is growing or shrinking, plus recent momentum (new funding, big customers, launches) or risks (down round, layoffs). Disambiguate using the website if the name is common. Then call report_growth. If search is too thin to be sure, report stage "unknown" rather than guessing.\n\n${seed}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, error: `Anthropic API ${res.status}: ${body.slice(0, 500)}` }, 502);
    }

    const data = await res.json();
    const toolUse = (data.content ?? [])
      .reverse()
      .find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "report_growth");
    if (!toolUse) {
      return json({ success: false, error: "judge did not return a growth verdict — try again" }, 502);
    }
    const out = toolUse.input as {
      stage: string;
      confidence: number;
      signals?: Record<string, unknown>;
      sources?: string[];
      rationale: string;
    };

    const { error: saveErr } = await admin.rpc("save_growth_judgment", {
      p_organization_id: org.organization_id,
      p_stage: out.stage,
      p_confidence: out.confidence,
      p_signals: out.signals ?? null,
      p_sources: out.sources ?? null,
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
