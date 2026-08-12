/**
 * intake-from-url — enrich a job posting from its link (T1.6).
 *
 * The UI equivalent of CLAUDE.md's Play 1 step 1: fetch the posting the user
 * pasted (Anthropic's server-side web_fetch tool — browser CORS blocks doing
 * this client-side) and extract the intake fields. Deliberately a PREFILL
 * layer, not a writer: it persists nothing and returns the extracted fields
 * for the Add-Role form to show, so the user reviews and corrects before
 * intake_role runs — which matters when the extracted salary drives the comp
 * score. Walled/JS-rendered postings (LinkedIn, many ATSes) fail fetch; the
 * response says so and the hand-typed form remains the fallback.
 *
 * Also returns `jd_text`: the posting body web_fetch pulled down, which this
 * used to discard. intake_role stores it, and that's what lets the JD decode run
 * at intake and be regenerated later without asking the user to paste the same
 * text back in (migration 026).
 *
 * Mirrors judge-growth's auth + call shape (the web_search precedent).
 * Secrets: ANTHROPIC_API_KEY (required), JUDGE_MODEL (optional).
 */

import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

// Server-side fetch tool. It can only retrieve URLs already present in the
// conversation — fine here, the user's URL is in the message.
const WEB_FETCH_TOOL = { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 };

const ROLE_TOOL = {
  name: "report_role",
  description:
    "Report the job posting's intake fields, grounded ONLY in the fetched page. Omit any field the page doesn't state — never guess. If the fetch failed, returned a login wall, or the page is not a job posting, call this with fetch_failed: true instead of inventing fields.",
  input_schema: {
    type: "object",
    properties: {
      fetch_failed: {
        type: "boolean",
        description: "true when the page couldn't be read (auth wall, JS-only render, 404, not a posting). All other fields are ignored when set.",
      },
      organization_name: { type: "string", description: "The hiring company, e.g. 'Anthropic' — not the job board's name." },
      title: { type: "string", description: "The role title as posted." },
      salary_min: { type: "number", description: "Annual base minimum in USD, if the posting states a range." },
      salary_max: { type: "number", description: "Annual base maximum in USD." },
      location: { type: "string", description: "e.g. 'New York, NY' or 'Remote (US)'." },
      remote_policy: { type: "string", enum: ["remote", "hybrid", "onsite"] },
      requirements: {
        type: "array",
        items: { type: "string" },
        description: "The core requirements, each compressed to a short phrase.",
      },
      nice_to_haves: { type: "array", items: { type: "string" } },
      notes: { type: "string", description: "1-2 sentences of anything else intake-worthy (team, mission, unusual terms)." },
    },
  },
};

/**
 * The posting body web_fetch already pulled down, out of the tool-result block.
 *
 * This used to be thrown away, and the cost of that showed up two features
 * later: the JD decode had to ask the user to paste the same text back in, once
 * per interview round. Extracting it here means intake captures it once and
 * every later re-run reads it from the posting.
 *
 * Not asked of the model as a field: it would paraphrase, and decode's whole
 * job is reading the exact wording. Defensive about shape because the block
 * layout is the API's, not ours — a miss returns null and the paste box remains
 * the fallback, which is strictly better than throwing away the intake.
 */
function extractFetchedText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; content?: unknown };
    if (b?.type !== "web_fetch_tool_result") continue;
    // web_fetch_tool_result.content is a document block whose source carries the
    // page text; an error result has no document at all.
    const doc = (b.content as { content?: { text?: string }; source?: { data?: string; text?: string } } | undefined);
    const text = doc?.content?.text ?? doc?.source?.text ?? doc?.source?.data;
    if (typeof text === "string" && text.trim()) texts.push(text.trim());
  }
  if (texts.length === 0) return null;
  // Longest wins: max_uses is 3, and a redirect or consent page fetched on the
  // way is short next to the real posting.
  const best = texts.sort((a, b) => b.length - a.length)[0];
  // Cap it. A posting is a few KB; anything far past that is page furniture, and
  // this lands in a text column that decode re-sends on every run.
  return best.slice(0, 60_000);
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

    // Auth-gated even though nothing is written: this call spends API tokens.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ success: false, error: "missing Authorization" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ success: false, error: "invalid auth" }, 401);

    const { url } = await req.json();
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return json({ success: false, error: "a http(s) posting url is required" }, 400);
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
        max_tokens: 2000,
        system:
          "You extract structured intake fields from ONE job posting for a job-search tracker. Fetch the URL with " +
          "web_fetch, read the posting, then call report_role with only what the page actually states — salary " +
          "figures especially must come from the page, never from your priors about the company or market. " +
          "Compress each requirement to a short phrase. If the fetch fails or the content is a login/consent wall " +
          "rather than the posting, call report_role with fetch_failed: true.",
        tools: [WEB_FETCH_TOOL, ROLE_TOOL],
        // Auto so the model can web_fetch first, THEN call report_role.
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: `Extract the intake fields from this job posting: ${url}` },
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
      .find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "report_role");
    if (!toolUse) {
      return json({ success: false, error: "no fields extracted — the page may be unreadable; fill the form by hand" }, 502);
    }
    const out = toolUse.input as Record<string, unknown> & { fetch_failed?: boolean };
    if (out.fetch_failed) {
      return json({
        success: false,
        error: "Couldn't read that page (login wall or script-rendered). Fill the fields by hand — LinkedIn and most ATS links are like this.",
      });
    }

    return json({ success: true, role: out, jd_text: extractFetchedText(data.content) });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
