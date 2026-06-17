# Job Hunt Pipeline

> A job search run as a data pipeline — not a spreadsheet.

Postings, applications, interviews, and funnel metrics are modeled as **facts on
shared `organizations` + `contacts` dimensions**, force-ranked by a transparent
0–100 **priority score**, and worked from two surfaces that share one logic layer:

- **A conversational agent** — an MCP you drive from Claude ("I'm tracking a role
  at Anthropic", "I have a screen Tuesday", "how's it going?").
- **A tracking-hub dashboard** — a React SPA ([`web/`](web/)) for the pipeline,
  funnel, résumés, and insights.

**AI judges** score each role against your résumé, your career trajectory, and the
company's growth, so the queue reflects real fit instead of gut feel.

Built as extension 6 of the open-brain learning path; it runs against that stack's
canonical Supabase schemas (organizations, contacts, events) with row-level
security, so a recruiter is just a `contact` and an employer is just an
`organization` — reusable long after the search ends.

---

## Features

**Track** — one transactional `intake_role` call finds-or-creates the company and
adds the posting; applications, status transitions, and interviews are logged
automatically (an `application_status_history` trigger makes the funnel
trustworthy). Interviews can write through to your calendar.

**Prioritize** — every un-applied role gets a 0–100 score from five weighted
components (fit · location · comp · career · growth). The apply queue is
force-ranked, so "what do I work next" is the top card. Weights live in a
[YAML semantic layer](semantic/), not buried in code.

**Judge with AI** — four server-side judges (Claude) fill the subjective signals:
- `judge-fit` scores each résumé variant against a JD (spikes / gaps / tweaks),
- `judge-career` reads the JD against your career profile → step_up / lateral / step_back,
- `judge-growth` web-searches the company's stage and momentum,
- `synthesize-feedback` rolls every judge's résumé tweaks into ranked, bucketed themes.

**Analyze** — true conversion + median time-in-stage from the status history; a
résumé-fit-vs-(career+growth) scatter on the Insights page; per-company pages.

---

## Getting started

### Prerequisites

- A Supabase project with the open-brain canonical schemas already applied:
  **organizations**, **family-calendar** (`contacts`, `events`, and the shared
  `update_updated_at_column()`), and **professional-crm**. These provide the dims
  this extension layers facts onto.
- The **Supabase CLI**, and an **Anthropic API key** (for the AI judges).
- Node 18+ to run the dashboard.

### 1. Apply the database layer

In the Supabase SQL editor, run in order:

```
schema.sql        # tables, triggers, RLS
functions.sql     # the shared logic layer (reads + transactional writes)
```

On a database that already ran an earlier `schema.sql`, apply the new
[`migrations/`](migrations/) in numeric order (001 → 008) first, then **re-run
`functions.sql`** — every function is `CREATE OR REPLACE`, so re-applying is safe
and is how the RPCs behind each migration get installed.

### 2. Deploy the agent (MCP)

Copy `index.ts` **and** `deno.json` together into your open-brain functions dir,
then deploy:

```bash
supabase functions deploy job-hunt-mcp --no-verify-jwt
```

Add it to Claude as a connector with `?key=<MCP_ACCESS_KEY>`.

### 3. Deploy the AI judges

Each judge is a folder under [`supabase/functions/`](supabase/functions/) with its
own `index.ts` + `deno.json`. Set the secret once, then deploy them:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # JUDGE_MODEL optional
supabase functions deploy judge-fit judge-career judge-growth synthesize-feedback
```

### 4. Run the dashboard

```bash
cd web
cp .env.example .env.local      # fill in your Supabase URL + anon key
npm install
npm run dev                     # http://localhost:5173
```

Sign in with the magic link as the Supabase Auth user whose `auth.uid()` owns the
data. See [`web/README.md`](web/README.md) for the page-by-page tour.

### 5. Track your first role

In Claude: *"I'm tracking a Senior AI Engineer role at Anthropic — here's the
link."* The agent enriches the JD and calls `intake_role`. Upload a résumé on the
dashboard's **Resumes** tab, then hit **Run AI judge** on the role to score it for
real. The full agent playbook is in [`CLAUDE.md`](CLAUDE.md).

---

## How it works

**Two planes, one logic layer.** The aggregations and multi-step writes live in
[`functions.sql`](functions.sql) as Postgres functions, called from both sides:
the **agent** (MCP tools are thin `rpc(...)` wrappers, service role passing
`p_user_id`) and the **dashboard** (supabase-js `rpc(...)`, RLS-scoped to
`auth.uid()`). So "paste a link → create the org → start tracking" is one
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

The three subjective signals come from the AI judges (or can be set by hand);
location and comp are derived from columns intake already captured. Weights are the
source of truth in
[`semantic/metrics/priority_score.yaml`](semantic/metrics/priority_score.yaml) and
mirrored as `DEFAULT`s on `compute_priority()` so the function runs standalone.

**Résumés** are a dimension (`resumes`) of named variants (e.g. a senior-IC and a
manager résumé), one marked default. The agent reads the default via `get_resume`;
the judge scores every variant against a role and recommends one.

---

## Project layout

```
schema.sql            Tables, triggers, RLS
functions.sql         The shared logic layer (reads + write RPCs)
migrations/           Ordered deltas (001–008); re-run functions.sql after
index.ts / deno.json  The job-hunt MCP (agent surface)
supabase/functions/   AI judges: judge-fit, judge-career, judge-growth,
                      synthesize-feedback
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
- Nothing personal lives in the repo: real résumés (`resume/resume.md`) and env
  files are git-ignored; only the placeholder and schema are committed.
