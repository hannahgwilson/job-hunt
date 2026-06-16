# Extension 6: Job Hunt Pipeline (v2)

> Tracks a job search as facts on top of the canonical dims. Companies live in `organizations`, recruiters and hiring managers live in `contacts`, and the only job-hunt-specific tables are `job_postings`, `applications`, `application_status_history`, and `interviews`.

## What's different from v1

v1 carried its own `companies` and `job_contacts` tables and had a `link_contact_to_professional_crm` bridge tool. v2 drops all three:

| v1 | v2 |
|---|---|
| `companies` table | `organizations` (shared dim) |
| `job_contacts` table | `contacts` with `tags=['professional','job-hunt']` |
| `professional_crm_contact_id` UUID on each job contact | (gone — contacts are in CRM by construction) |
| `applications.referral_contact` TEXT | `applications.referral_contact_id` UUID FK → contacts |
| `interviews.interviewer_name` + `interviewer_title` TEXT | `interviews.interviewer_contact_id` UUID FK → contacts |
| Status snapshot only | Auto-logged `application_status_history` for true funnel metrics |
| (no calendar surface) | Optional `interviews.event_id` writes through to `events` for week-view surfacing |

## Why

A recruiter you're talking to is also a contact worth maintaining. Modeling them in a separate `job_contacts` table fragments the contacts ontology and means you have to bridge back to CRM with a special tool. With v2 they're just contacts with extra tags — every CRM operation already works on them.

Same logic for companies. "TechCorp" the employer you're applying to and "TechCorp" the company your friend works at are the same real-world institution. Modeling them as one `organizations` row means a single update is enough.

## Schema

```
job_postings              -- descriptive dim: a role at an org
  organization_id FK -> organizations
  title, url, salary_min/max, requirements[], remote_policy, source,
  posted_date, closing_date, ...

applications              -- fact: one row per submitted application
  job_posting_id FK -> job_postings
  referral_contact_id FK -> contacts
  status, applied_date, response_date, resume_version, ...

application_status_history -- auto-logged fact, populated by trigger
  application_id FK -> applications
  from_status, to_status, changed_at, notes

interviews                -- fact: one row per interview event
  application_id FK -> applications
  interviewer_contact_id FK -> contacts
  event_id FK -> events            (optional calendar bridge)
  interview_type, scheduled_at, status, rating, feedback, ...
```

## Prerequisites

Apply these schemas **before** job-hunt:

1. Family calendar — `contacts`, `locations`, `events`, plus the `update_updated_at_column()` function shared with this extension. ([extensions/family-calendar/](../family-calendar/))
2. Professional CRM — `contact_interactions`, `opportunities`, contacts FTS. ([extensions/professional-crm/](../professional-crm/))
3. Organizations — the `organizations` dim plus `contacts.organization_id` and `entities.organization_id` FKs. ([schemas/organizations/](../../schemas/organizations/))

## Deploy

```bash
# 1. Apply the SQL, in order, in the Supabase SQL editor:
#      schema.sql      — tables, triggers, RLS
#      functions.sql   — read aggregations + write RPCs (the shared logic layer)
#    On a database that already ran an earlier schema.sql, also apply:
#      migrations/001_interview_decisions.sql   — adds interview go/no-go columns
#      migrations/002_priority_scoring.sql      — adds the prioritization signals
#      migrations/003_resume_profile.sql         — adds the resume/profile table
#    (then re-run functions.sql — it adds compute_priority / get_prioritized_roles
#     / get_resume / upsert_resume)

# 2. Deploy the MCP Edge Function (copy index.ts AND deno.json together)
cp index.ts   <open-brain>/supabase/functions/job-hunt-mcp/index.ts
cp deno.json  <open-brain>/supabase/functions/job-hunt-mcp/deno.json
cd <open-brain>
supabase functions deploy job-hunt-mcp --no-verify-jwt
```

Add as a Claude Desktop connector with `?key=<MCP_ACCESS_KEY>`.

### Two planes, one logic layer

The aggregations and multi-step writes live in **`functions.sql`** as Postgres
functions, so they are written once and called from both sides:

- **The agent (this MCP)** — tools are thin `supabase.rpc(...)` wrappers; the
  service role passes `p_user_id` explicitly.
- **The tracking-hub SPA** (`web/`) — calls the same `rpc(...)` directly via
  supabase-js, scoped by RLS to the logged-in user (`p_user_id` defaults to
  `auth.uid()`).

This is why "paste a job link → build the org → start tracking" is one
transactional `intake_role` call instead of brittle chained inserts.

## Prioritization & the semantic layer

The action queue doesn't just list roles to apply to — it **force-ranks** them by
a 0–100 priority score, so "what do I work next" is the top card. The score is a
weighted sum of five components, defined once and consumed everywhere:

```
priority_score = 100 * (
    0.35 * experience   // fit of the JD vs my resume          (agent-judged 0..1)
  + 0.15 * location     // hybrid-NYC > remote > onsite-NYC …   (derived)
  + 0.15 * comp         // salary midpoint normalized to a band (derived)
  + 0.20 * career       // step_up > lateral > step_back        (agent-judged)
  + 0.15 * growth       // growth/early > late/seed > public    (agent-judged)
)
```

Three of the signals are subjective reads the agent supplies from the JD and my
résumé. The résumé is **uploaded from the tracking hub** (the Resume page → stored
in `job_search_profile`, RLS-scoped) and the agent reads it via `get_resume` when
judging `experience_alignment`; `resume/resume.example.md` is just the committed
placeholder that documents the expected shape. Location and comp are scored
deterministically from columns intake already captured.

**The metric definitions live in a lightweight YAML semantic layer**, not buried
in code — see [`semantic/`](semantic/). Each metric (`time_in_stage`,
`conversion_rate`, `priority_score`) is a spec that points at the SQL function
implementing it, so there's one canonical definition the agent, the UI, and I all
read. The priority weights are the source of truth in
[`semantic/metrics/priority_score.yaml`](semantic/metrics/priority_score.yaml) and
mirrored as `DEFAULT`s on `compute_priority()` so the function runs standalone.

| Surface | What it shows |
|---|---|
| `compute_priority()` | pure scoring of one posting → `{ score, components, weights }` |
| `get_prioritized_roles()` / `get_action_queue().roles_to_apply` | the unapplied roles, ranked high→low |
| Action Queue page (`web/`) | rank + score badge + per-component fit bars |

## Tools

| Tool | Purpose |
|---|---|
| `intake_role` | One-call intake: find-or-create the org **by name** + add the posting (wraps `intake_role()`). Also accepts the prioritization signals. Replaces `add_job_posting` + a separate org lookup. |
| `set_priority_signals` | Update a posting's prioritization signals (`experience_alignment`, `career_trajectory`, `growth_stage`) after intake; returns the recomputed score. |
| `get_prioritized_roles` | Force-rank the roles I haven't applied to yet by priority score (0–100), with per-role component breakdown. |
| `get_resume` | Fetch the stored long-form resume — read it before judging `experience_alignment`. |
| `set_resume` | Save / replace the stored resume text. |
| `submit_application` | Record a new application; status defaults to `'applied'`. Tracking starts here. |
| `update_application_status` | Move an application to a new status (wraps `advance_application()`). Transition auto-logged. |
| `schedule_interview` | Schedule an interview. `add_to_calendar: true` also writes a row in `events`. |
| `log_interview_notes` | Feedback + rating **+ go/no-go `advance_decision`**; marks status `completed`. |
| `list_postings` | List postings, optional org filter. |
| `list_applications` | List applications, optional status + org filter. |
| `get_pipeline_overview` | Status breakdown + upcoming interviews. The "how's it going?" tool. |
| `get_upcoming_interviews` | Scheduled interviews in the next N days. |
| `get_action_queue` | The to-do list: roles to apply, follow-ups, upcoming interviews, stale networking contacts. |
| `get_funnel_metrics` | True conversion rates between stages + median time-from-applied. |

## Typical flow with Claude

```
You: "I'm tracking a Senior AI Engineer role at Anthropic."

Claude:
  1. organizations-mcp `org_find_or_create({ name: "Anthropic" })` -> org_id
  2. job-hunt `add_job_posting({ organization_id: org_id, title: "Senior AI Engineer", ... })` -> posting_id

You: "I submitted the application today. Jessica Lee referred me — recruiter at Anthropic."

Claude:
  1. professional-crm `crm_add_contact({ name: "Jessica Lee", company: "Anthropic", ... tags: ["professional", "job-hunt"] })` -> contact_id
  2. organizations-mcp `org_link_contact({ contact_id, org_id })`
  3. job-hunt `submit_application({ job_posting_id: posting_id, referral_contact_id: contact_id, applied_date: "2026-06-12" })`

You: "I have a phone screen with Jessica Tuesday at 2pm — put it on the calendar."

Claude:
  job-hunt `schedule_interview({
    application_id, interview_type: "phone_screen",
    scheduled_at: "2026-06-16T14:00:00-04:00", duration_minutes: 30,
    interviewer_contact_id: jessica_id, add_to_calendar: true
  })`

You: "How's the search going overall?"

Claude:
  job-hunt `get_pipeline_overview()` + optionally `get_funnel_metrics()`
```

## What this unblocks

- **Cross-extension queries.** "All my interviews at remote-friendly enterprise companies" is now one `interviews ⨝ applications ⨝ job_postings ⨝ organizations` query.
- **Reusable recruiter network.** When the job search ends, the recruiters don't go away — they're still in `contacts` with all their interaction history in `contact_interactions`. Searching CRM for "Jessica Lee" still finds her.
- **True funnel analytics.** Because every status transition gets logged, `get_funnel_metrics` can give you "your phone-screen → onsite conversion is 60%, median 5 days" without trusting the writer to remember.
- **Calendar surfacing.** Scheduled interviews appear in the weekly schedule generator alongside swim lessons and dinner duty.

## Notes

- No migration script here because v2 is the canonical target state and this extension hasn't been deployed to Supabase yet. If you ever applied v1's `schema.sql` somewhere, write a separate one-shot migration that mirrors `schemas/organizations/migrations/001_backfill_contacts_company.sql` — same idea, different source tables.
- `application_status_history` is populated only on INSERT to `applications` and on UPDATE OF `status` (see the trigger). If you change other columns, the history isn't touched.
- `interviews.interviewer_contact_id` is single-valued. Panel interviews currently store the primary interviewer; a junction table can replace this if it ever matters.
