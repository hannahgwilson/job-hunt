# Discovery — Prioritizable action checklist (on a shared `tasks` dim)

Status: **discovery complete, awaiting build go-ahead** · Owner: Hannah · 2026-06-30

## Problem

The Action Queue (`web/src/pages/ActionQueue.tsx`, backed by `get_action_queue`)
is entirely *derived* — four read-only computed buckets. There is no persisted,
hand-managed to-do anywhere. Three requested features all reduce to one missing
primitive: **a persisted, prioritizable checklist of action items**, with three
feeders. Per Hannah: the table must be **general-purpose**, usable outside the job
hunt — so it's a canonical dim, not a job-hunt table.

## The core primitive — canonical `tasks` (lives in OB1)

A new **shared schema** `OB1/schemas/tasks/`, sibling of `organizations` —
cross-cutting, referenced by extensions rather than owned by one. Generic core,
**no domain columns**:

```
tasks  (canonical fact — any area: job-hunt, family, household, personal…)
  id, user_id, title, detail
  status     open | done | dismissed | snoozed
  priority   asap | high | normal | low          -- the "tag as ASAP" lever
  sort_order numeric                              -- manual drag-rank within a tier
  due_date
  domain     text     -- 'job-hunt' | 'family' | 'household' | 'personal' …  ← discriminator
  kind       text     -- free within a domain (apply, followup, chore, errand…)
  thought_id text     -- soft ref to Open Brain (already cross-domain)
  source     text     -- manual | open_brain | crm | auto | …
  completed_at, created_at, updated_at
  + RLS, updated_at trigger (mirrors organizations)

task_dismissals  (generic inbox dismiss-memory)
  user_id, suggestion_key text, dismissed_at
  UNIQUE (user_id, suggestion_key)
```

Each domain attaches via **its own nullable FK columns**, added by that
extension's migration (the `contacts.organization_id` precedent). Job-hunt's
migration ALTERs `tasks` to add:

```
job_posting_id -> job_postings(id)   application_id -> applications(id)
interview_id   -> interviews(id)     contact_id     -> contacts(id)
```

Family-calendar could later add `event_id`, etc. Real FKs → clean joins + cascade.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Priority model | **Tiers (ASAP/High/Normal/Low) + drag-order** within a tier (`priority` enum + `sort_order`). |
| 2 | ASAP ↔ algorithmic ranking | **Checklist only.** Tagging a role ASAP creates a task; the Pipeline force-ranking stays objective. Two separate axes. |
| 3 | Open Brain / CRM items | **Live inbox + promote**, read at query time (no copy), **with dismiss** (`task_dismissals` — dismissed items never reappear). |
| 4 | Interview prep depth | **Static assembly first** from existing data (growth judge, `role_fit`, interviewer contact, OB notes). AI prep-sheet edge fn is a fast-follow. |
| 5 | Task ↔ object linking | **Per-domain FK columns**, added by each extension (Kimball-clean, matches `contacts.organization_id`). |
| 6 | Ownership / placement | **Canonical in OB1** (`schemas/tasks/`), applied to Supabase via the SQL editor; documented in `open-brain/docs/SCHEMA.md`. |
| 7 | Relationship to OB task-thoughts | **Two layers, bridged.** `thoughts` (`type='task'` + `workflow-status.status`) stays the lightweight *capture* layer; `tasks` is the *structured actionable* layer. Promoting a task-thought from the inbox creates a `tasks` row (`thought_id` set) **and flips the thought's `status` to `'promoted'`** so it stops surfacing. One source of truth per layer. |

## Tech-debt cleanups bundled into this build

Found while auditing the seams (see git history of this doc). All three approved:

1. **Force-ranking de-dup** — `get_action_queue.roles_to_apply` re-inlines the
   ranking from `get_prioritized_roles` *without* its `comp_floor`/`comp_target`
   args, so the two can score a role differently. Fix: `get_action_queue` calls
   `get_prioritized_roles`. (Done as part of Phase B's `functions.sql` rewrite.)
2. **Stale OB1 fork** — `OB1/extensions/job-hunt/` is a 223-line copy of code
   extracted to `~/repos/job-hunt` (548 lines, canonical since 2026-06-14). Delete
   it / replace with a pointer README so nobody edits the wrong source.
3. **Dead `job_search_profile`** — superseded by `resumes` (migration 004).
   Verify the 004 backfill ran, drop the table + its RLS/trigger, remove the
   schema.sql block, and fix the stale `job-hunt-mcp/index.ts:42` comment that
   still tells the agent to read it.

Deferred (logged, not in this build):

- The `thoughts.status` column is `ADD COLUMN IF NOT EXISTS`'d by both
  `workflow-status` and `enhanced-thoughts` — add a one-line ownership comment
  when next editing either schema.
- **`get_interview_prep` → conversational AI brief (round two).** The v1 shipped
  here is static SQL assembly. After round one, replace/augment it with an
  `interview-prep` edge function (modeled on `judge-fit`) that calls the Anthropic
  API to synthesize a tailored brief — likely questions, STAR-story prompts vs the
  JD + résumé, gap talking points. The `[ Generate AI prep sheet ]` button is the
  stub for it.

## Feature 1 — populate from a role/application

`★ Add to checklist ▾` (ASAP / High / Normal) on `RoleDetail` and the
`RolesToApplyTable` row inserts a `domain='job-hunt'`, `kind='apply'` task linked
via `job_posting_id`. "Tag Komodo Health ASAP" → one task pinned to ASAP. (Komodo
Health is a confirmed real role in the to-apply queue.)

## Feature 2 — Open Brain thoughts + scheduled follow-ups (live inbox)

`get_suggestions()` (job-hunt RPC) unions at query time — all tables are in the
**same Supabase project**:
- **Open Brain `job-search` thoughts** — read `thoughts` directly; prefer
  `type='task'` for actionable ones, others as context.
- **Scheduled follow-ups** — `contacts.follow_up_date` (CRM) + dated OB task-thoughts.
- **Top roles to apply** — a few highest-priority unapplied roles, as a feeder.

Each suggestion carries a stable `suggestion_key` (`thought:<id>`,
`crm:<contact_id>`, `posting:<id>`). The RPC excludes keys already promoted to a
task or recorded in `task_dismissals`. `[+ add]` promotes → real task;
`[× dismiss]` writes a dismissal so it never returns.

> Build-time check: confirm `thoughts` column names (content/type/tags[], any
> scheduled column). The two reliable scheduled sources today are
> `contacts.follow_up_date` and `type='task'` job-search thoughts.

## Feature 3 — interview prep (static assembly)

For each interview `scheduled` (next window) or whose application is
`interviewing`, `get_interview_prep(interview_id)` assembles from existing data:
- **Company intel** — `organizations` growth signals (judge-growth) + OB company notes.
- **Fit recap** — best `role_fit` row (spikes / gaps / recommended résumé).
- **Interviewer** — `interviews.interviewer_contact_id` → contact + CRM history.
- **Checklist scaffold** — questions / logistics, persisted as `kind='interview_prep'`
  tasks linked via `interview_id`.

`[ Generate AI prep sheet ]` stubbed now; future `interview-prep` edge fn
(modeled on `judge-fit`) synthesizes a tailored brief.

## Surfaces

- **Action Queue page** → `MY CHECKLIST` (tiers + drag + check-off, `domain='job-hunt'`)
  above a `SUGGESTED` inbox (add / dismiss). Existing derived buckets fold in.
- **RoleDetail / RolesToApplyTable** → `★ Add to checklist` control.
- **Interview prep** → card on `RoleDetail` per upcoming interview (v1).

## Build phases (multi-repo)

- **A — Canonical schema (OB1).** `OB1/schemas/tasks/{schema.sql,metadata.json,README.md}`:
  `tasks` + `task_dismissals` + RLS + triggers + generic CRUD RPCs (`task_create`,
  `task_set_status`, `task_set_priority`, `task_reorder`, `task_list`). Apply via
  Supabase SQL editor. Update `open-brain/docs/SCHEMA.md` ERD + deploy list.
- **B — Job-hunt extension (job-hunt repo).** `migrations/016_action_checklist.sql`
  ALTERs `tasks` to add job-hunt FK columns. `functions.sql`: `get_job_checklist`,
  `get_suggestions`, `dismiss_suggestion`, `get_interview_prep`.
- **C — MCP tools.** `job-hunt-mcp/index.ts`: `add_task`, `list_tasks`,
  `complete_task`, `prioritize_task`, `dismiss_suggestion` — conversational writes.
  (Optional fast-follow: a shared `tasks-mcp` for cross-domain use.)
- **D — Web.** `types.ts`, `api.ts`, rebuilt `ActionQueue.tsx`, `Checklist` +
  `SuggestionInbox` + `InterviewPrep` components, the `Add to checklist` control.

> Schema apply (SQL editor) and Edge Function deploys are outward-facing steps —
> run/authorized by Hannah, not done silently.
</content>
