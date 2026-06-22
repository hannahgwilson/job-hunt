# Job Hunt Pipeline

> A job search run as a data pipeline — not a spreadsheet.

**This is a flagship portfolio project — and a real app I use to run my own job
search every day.** It models a job hunt as facts on shared dimensions, scores
every role with AI against a transparent rubric, and tailors résumés per posting —
across two surfaces (a conversational agent and a dashboard) that share one
Postgres logic layer so they can't drift.

Postings, applications, interviews, and funnel metrics are **facts on shared
`organizations` + `contacts` dimensions**, force-ranked by a transparent 0–100
**priority score**, worked from:

- **A conversational agent** — an MCP you drive from Claude ("I'm tracking a role
  at Anthropic", "I have a screen Tuesday", "how's it going?").
- **A tracking-hub dashboard** — a React SPA ([`web/`](web/)) for the pipeline,
  funnel, résumés, insights, and per-company pages.

**AI judges** score each role against your résumé (detecting whether it's an IC or
a manager role first), your career trajectory, and the company's growth, so the
queue reflects real fit — not gut feel.

> **Your data stays yours.** Every table is row-level-security isolated to your
> Supabase Auth user; an external visitor sees nothing. See
> [Privacy & data isolation](#privacy--data-isolation).

Built as extension 6 of the open-brain learning path, it runs against that stack's
canonical Supabase schemas — so a recruiter is just a `contact` and an employer is
just an `organization`, reusable long after the search ends.

---

## Features

**Track** — one transactional `intake_role` call finds-or-creates the company and
adds the posting; applications, status transitions, and interviews log
automatically (a status-history trigger makes the funnel trustworthy). Interviews
can write through to your calendar.

**Prioritize — and tune it live** — every un-applied role gets a 0–100 score from
five weighted components (fit · location · comp · career · growth). The apply queue
is force-ranked, so "what do I work next" is the top card. **Sliders on the
Pipeline page** let you re-weight the search; the change persists per-user and
re-ranks the queue immediately — for both the dashboard and the agent.

**Judge with AI** — five server-side Claude functions fill the subjective work:
- `judge-fit` — decides whether the JD is an **IC or a manager role**, then scores
  each résumé variant against the skills that track demands (spikes / gaps /
  tweaks), and flags a track mismatch (an IC résumé aimed at a manager role);
- `judge-career` — reads the JD against your career profile → step_up / lateral / step_back;
- `judge-growth` — web-searches the company's stage and momentum;
- `synthesize-feedback` — rolls every judge's résumé tweaks into ranked, bucketed themes;
- `assemble-resume` — selects and orders the strongest bullets from your library to
  draft a one-page résumé tailored to a specific JD.

**Build résumés** — a **bullet library** of reusable, tagged, orderable lines; the
generator picks the best of them per JD into an editable one-pager. Synthesis
themes can be promoted straight into the library.

**Analyze** — true conversion + median time-in-stage from the status history; a
résumé-fit-vs-(career+growth) scatter on the Insights page; per-company pages.

---

## Getting started

You need: a **Supabase project** with the open-brain canonical schemas applied
(**organizations**, **family-calendar** — which provides `contacts`, `events`, and
the shared `update_updated_at_column()` — and **professional-crm**); the **Supabase
CLI**; an **Anthropic API key** (for the AI functions); and **Node 18+**.

```bash
# 1. Database — in the Supabase SQL editor, run in order:
#      schema.sql      (tables, triggers, RLS)
#      functions.sql   (the shared logic layer — reads + transactional writes)
#    Upgrading an existing DB? Apply migrations/ in numeric order (001 → 012)
#    first, then re-run functions.sql (every function is CREATE OR REPLACE).

# 2. Agent (MCP) — lives at supabase/functions/job-hunt-mcp/ (index.ts + deno.json),
#    alongside the AI functions below. Deploy it from this repo (the Supabase
#    project link is enough; no config.toml needed):
supabase functions deploy job-hunt-mcp --no-verify-jwt
#    Add it to Claude as a connector with ?key=<MCP_ACCESS_KEY>.

# 3. AI functions — set the secret once, then deploy all five:
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # JUDGE_MODEL optional
supabase functions deploy judge-fit judge-career judge-growth \
                          synthesize-feedback assemble-resume

# 4. Dashboard
cd web
cp .env.example .env.local      # fill in your Supabase URL + anon key
npm install
npm run dev                     # http://localhost:5173
```

Sign in with the magic link as the Supabase Auth user who owns the data, then
**track your first role**: in Claude, *"I'm tracking a Senior AI Engineer role at
Anthropic — here's the link."* The agent enriches the JD and calls `intake_role`.
Add a résumé on the **Resumes** tab and hit **Run AI judge** on the role to score
it for real. The full agent playbook is in [`CLAUDE.md`](CLAUDE.md); the page tour
is in [`web/README.md`](web/README.md).

---

## How it works

**Two planes, one logic layer.** The aggregations and multi-step writes live in
[`functions.sql`](functions.sql) as Postgres functions, called from both sides: the
**agent** (MCP tools are thin `rpc(...)` wrappers, service role passing
`p_user_id`) and the **dashboard** (supabase-js `rpc(...)`, RLS-scoped to
`auth.uid()`). "Paste a link → create the org → start tracking" is one
transactional `intake_role`, never brittle chained inserts — and the two surfaces
can't drift.

**The priority score** is a weighted sum, defined once and consumed everywhere:

```
priority_score = 100 * (
    0.35 * experience   // résumé vs JD            (AI-judged 0..1)
  + 0.15 * location     // hybrid-NYC > remote > … (derived)
  + 0.15 * comp         // salary midpoint → band  (derived)
  + 0.20 * career       // step_up > lateral > …   (AI-judged)
  + 0.15 * growth       // growth/early > … public (AI-judged)
)
```

Those are the **defaults** — the source of truth in
[`semantic/metrics/priority_score.yaml`](semantic/metrics/priority_score.yaml),
mirrored as `DEFAULT`s on `compute_priority()`. Per-user overrides live in the
`priority_weights` table (the Pipeline sliders); `resolve_priority_weights()` feeds
them to the ranking so the dashboard and the agent always agree.

**Résumés, two ways.** Variants (`resumes`) are whole documents — a senior-IC and a
manager version, one default the agent reads. Bullets (`resume_bullets`) are the
composable raw material the JD-tailored generator draws on. `judge-fit` scores
every variant against a role and recommends one.

---

## Privacy & data isolation

This is a single-tenant app: **everything is keyed to your Supabase Auth user, and
an external person can't see your information.** The guarantees, verifiable in
[`schema.sql`](schema.sql):

- **Row-Level Security on every table.** All 13 tables have RLS enabled with a
  `USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)` policy — a query
  can only ever touch rows owned by the caller.
- **RLS actually applies to the app's queries.** Every SQL function is
  `SECURITY INVOKER` (no `SECURITY DEFINER` bypass), so the dashboard's `rpc(...)`
  calls run under the caller's policies, not the definer's.
- **The browser can't read anything on its own.** The SPA ships only the public
  **anon** key, which has no `auth.uid()` until you sign in (magic link only) — and
  RLS yields zero rows without a matching `user_id`. No table grants to `anon` /
  `public`; `EXECUTE` is limited to `authenticated` + `service_role`.
- **The privileged key never leaves the server.** The `service_role` key lives only
  in Supabase Edge Function secrets; the AI functions verify your JWT and scope
  every read/write to your `user_id`. It's never in the repo or the browser bundle.
- **No personal data in the repo.** Real résumés (`resume/resume.md`) and env files
  are git-ignored; only the placeholder and schema are committed.

Net: another signed-in user would see only their own rows; an anonymous visitor
sees nothing.

---

## Project layout

```
schema.sql            Tables, triggers, RLS
functions.sql         The shared logic layer (reads + write RPCs)
migrations/           Ordered deltas (001–012); re-run functions.sql after
supabase/functions/   job-hunt-mcp (the agent surface) + the AI functions:
                      judge-fit, judge-career, judge-growth,
                      synthesize-feedback, assemble-resume
semantic/             YAML metric specs → the SQL that implements them
resume/               resume.example.md — the expected long-form shape
web/                  The tracking-hub SPA (Vite + React)
CLAUDE.md             How to drive the search from Claude (the agent plays)
```

## Going deeper

- [`CLAUDE.md`](CLAUDE.md) — the repeatable plays the agent runs (intake, track,
  weekly review, prioritize).
- [`web/README.md`](web/README.md) — the dashboard: pages, RPCs, and the judges.
- [`semantic/`](semantic/) — the metric definitions (`priority_score`,
  `conversion_rate`, `time_in_stage`).

## Notes

- `application_status_history` is logged only on INSERT to `applications` and on
  UPDATE OF `status` — other column edits don't touch the history.
- `interviews.interviewer_contact_id` is single-valued; panel interviews store the
  primary interviewer (a junction table can replace it if needed).
- The AI functions run on `claude-sonnet-4-6` by default (override with the
  `JUDGE_MODEL` secret).
