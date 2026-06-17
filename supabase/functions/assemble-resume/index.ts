/**
 * assemble-resume — the AI behind the role page's "Build a tailored resume"
 * button.
 *
 * Given a job posting and the user's bullet library (resume_bullets), it makes
 * one Claude call that SELECTS and ORDERS the highest-leverage bullets for THIS
 * JD and drafts a tailored summary. The model only chooses bullet ids — it does
 * not rewrite bullet text — so the assembled body is rendered server-side from
 * the real library text (no hallucinated experience). The result is cached via
 * save_assembled_resume (one row per posting; regenerate overwrites). Returns the
 * fresh get_assembled_resume payload so the page re-renders.
 *
 * Why a separate edge function (not the MCP / not SQL): outbound Anthropic call
 * with a secret key, server-side only. Same skeleton as judge-fit /
 * synthesize-feedback (CORS, JWT→user_id, service-role client scoped to user_id,
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

// Structured-output tool: the model selects bullet ids per section + a tailored
// summary. It must NOT invent bullet text — only reference ids from the library.
const ASSEMBLY_TOOL = {
  name: "report_assembly",
  description:
    "Assemble a tailored one-page resume for a specific job description by selecting and ordering the strongest bullets from the candidate's library. Select only the bullets that earn their place against THIS JD — a one-pager is tight. Reference bullets by their exact id; never invent bullet text.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One sentence: the tailoring angle — how this resume is positioned for this JD.",
      },
      summary: {
        type: "string",
        description:
          "A tailored 2-3 sentence professional summary for THIS JD, grounded in the candidate's actual background (you may write this fresh — it's the one section that isn't a library bullet).",
      },
      sections: {
        type: "array",
        description: "Ordered resume sections, each a heading + the ordered bullet ids to include under it.",
        items: {
          type: "object",
          properties: {
            heading: { type: "string", description: "Section heading, e.g. 'Experience — Acme', 'Skills'." },
            bullet_ids: {
              type: "array",
              items: { type: "string" },
              description: "Ordered ids of library bullets to include under this heading. Must be ids from the provided library.",
            },
          },
          required: ["heading", "bullet_ids"],
        },
      },
      rationale: {
        type: "string",
        description: "Brief: what you led with and what you left off (and why), against this JD.",
      },
    },
    required: ["summary", "sections"],
  },
};

function jdContext(p: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push(`Title: ${p.title ?? "(untitled)"}`);
  if (p.location) parts.push(`Location: ${p.location}`);
  if (p.remote_policy) parts.push(`Remote policy: ${p.remote_policy}`);
  const reqs = (p.requirements as string[] | null) ?? [];
  if (reqs.length) parts.push(`Requirements:\n- ${reqs.join("\n- ")}`);
  const nice = (p.nice_to_haves as string[] | null) ?? [];
  if (nice.length) parts.push(`Nice to have:\n- ${nice.join("\n- ")}`);
  if (p.notes) parts.push(`Notes / JD excerpt:\n${p.notes}`);
  return parts.join("\n\n");
}

type Bullet = { id: string; section: string; org_label: string | null; text: string; tags: string[] | null };

// Render the library so the model can pick by id. Grouped by section for legibility.
function libraryContext(bullets: Bullet[]): string {
  const bySection = new Map<string, Bullet[]>();
  for (const b of bullets) {
    const k = b.section + (b.org_label ? ` — ${b.org_label}` : "");
    const arr = bySection.get(k);
    if (arr) arr.push(b);
    else bySection.set(k, [b]);
  }
  const blocks: string[] = [];
  for (const [section, items] of bySection) {
    const lines = items.map((b) => {
      const tags = b.tags?.length ? `  [tags: ${b.tags.join(", ")}]` : "";
      return `  - (id: ${b.id}) ${b.text}${tags}`;
    });
    blocks.push(`## ${section}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

// Build the one-page markdown from the model's selection + the REAL library text
// (id → bullet), dropping any id the model invented. Returns the body and the
// flattened ordered list of ids actually used.
function renderBody(
  title: string,
  summary: string,
  sections: Array<{ heading: string; bullet_ids: string[] }>,
  byId: Map<string, Bullet>,
): { body: string; usedIds: string[] } {
  const used: string[] = [];
  const out: string[] = [`# ${title}`];
  if (summary?.trim()) out.push(`## Summary\n${summary.trim()}`);
  for (const sec of sections) {
    const lines: string[] = [];
    for (const id of sec.bullet_ids ?? []) {
      const b = byId.get(id);
      if (!b) continue; // model referenced an id not in the library — skip
      used.push(id);
      lines.push(`- ${b.text}`);
    }
    if (lines.length) out.push(`## ${sec.heading}\n${lines.join("\n")}`);
  }
  return { body: out.join("\n\n"), usedIds: used };
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

    const { job_posting_id, base_resume_id } = await req.json();
    if (!job_posting_id) return json({ success: false, error: "job_posting_id required" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: posting, error: postErr } = await admin
      .from("job_postings")
      .select("id, title, location, remote_policy, requirements, nice_to_haves, notes")
      .eq("id", job_posting_id)
      .eq("user_id", userId)
      .single();
    if (postErr || !posting) return json({ success: false, error: "posting not found" }, 404);

    const { data: bullets, error: bErr } = await admin
      .from("resume_bullets")
      .select("id, section, org_label, text, tags")
      .eq("user_id", userId)
      .eq("is_active", true);
    if (bErr) throw bErr;

    const lib = (bullets ?? []) as Bullet[];
    if (lib.length === 0)
      return json({ success: false, error: "no bullets in your library yet — add some on the Resumes page first" }, 400);

    // Optional base resume just labels the draft; bullets carry the content.
    let title = "Tailored resume";
    if (base_resume_id) {
      const { data: base } = await admin
        .from("resumes").select("label").eq("id", base_resume_id).eq("user_id", userId).single();
      if (base?.label) title = base.label;
    }

    const byId = new Map(lib.map((b) => [b.id, b]));
    const jd = jdContext(posting);
    const libCtx = libraryContext(lib);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Generous so a large library + many sections don't truncate the tool
        // output mid-selection (see synthesize-feedback for the same trap).
        max_tokens: 8000,
        tools: [ASSEMBLY_TOOL],
        tool_choice: { type: "tool", name: "report_assembly" },
        messages: [
          {
            role: "user",
            content:
              `You are a sharp resume writer assembling a tight, one-page resume tailored to a specific job. ` +
              `Pick the strongest bullets from the candidate's library for THIS JD, order them so the most relevant land first, and write a tailored summary. ` +
              `Reference bullets ONLY by their exact id; do not invent or reword bullet text. Be selective — a one-pager can't hold everything.\n\n` +
              `=== JOB DESCRIPTION ===\n${jd}\n\n` +
              `=== BULLET LIBRARY (choose by id) ===\n${libCtx}\n\n` +
              `Call report_assembly with the tailored summary and the ordered section → bullet-id selections.`,
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
      headline?: string;
      summary: string;
      sections: Array<{ heading: string; bullet_ids: string[] }>;
      rationale?: string;
    };

    const { body, usedIds } = renderBody(title, out.summary, out.sections ?? [], byId);
    if (usedIds.length === 0)
      return json({ success: false, error: "the model selected no valid bullets — try adding more to the library" }, 502);

    const rationale = [out.headline, out.rationale].filter(Boolean).join("\n\n");

    const { error: saveErr } = await admin.rpc("save_assembled_resume", {
      p_job_posting_id: job_posting_id,
      p_body_md: body,
      p_selected_bullet_ids: usedIds,
      p_rationale: rationale || null,
      p_base_resume_id: base_resume_id ?? null,
      p_model: MODEL,
      p_user_id: userId,
    });
    if (saveErr) throw saveErr;

    const { data: fresh, error: freshErr } = await admin.rpc("get_assembled_resume", {
      p_job_posting_id: job_posting_id,
      p_user_id: userId,
    });
    if (freshErr) throw freshErr;

    return json(fresh);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
