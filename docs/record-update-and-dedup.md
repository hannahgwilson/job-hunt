# Requirement — generic record update + duplicate detection across connected tools

Status: **scoped, awaiting build** · Owner: Hannah · 2026-07-27

Cross-cutting requirement spanning the connected MCP servers (job-hunt,
professional-crm, organizations, family-calendar, household-knowledge,
open-brain). Job-hunt is the first concrete instance, not the scope.

Everything under "Verified" below was checked against the repo at the time of
writing. Two findings change the shape of the work — read those before
estimating.

---

## Problem

Most "add a new X" tools have no matching "edit X", and no duplicate detection
on the way in. Each server that does have write tools has invented its own
slightly different convention.

In job-hunt today:

| Tool | What it can change |
|---|---|
| `intake_role` | Inserts a **new** posting. Find-or-create is scoped to the *organization*, not the posting. |
| `set_priority_signals` | `experience_alignment`, `career_trajectory`, `growth_stage` — nothing else. |
| `close_role` / `reopen_role` | The closed/filled state only. |

So there is no supported way to add or correct `salary_min`, `salary_max`,
`location`, `remote_policy`, `notes`, `requirements`, `nice_to_haves`,
`posted_date`, or `closing_date` once a posting exists — and nothing stops
`intake_role` from creating a second posting for a role already tracked.

The same gap exists in shape at `organizations:org_find_or_create`, contacts,
vendors, and household items; it just hasn't been hit there yet. Build it once
as a shared pattern rather than patching job-hunt alone.

---

## Verified against the repo

**1. Every field this needs already exists — Requirement 1 needs no migration.**
All twelve columns in the posting field table below are already on
`job_postings` in `schema.sql`, including `salary_currency` (defaulting to
`'USD'`), `nice_to_haves TEXT[]`, `posted_date DATE`, and `notes TEXT`. For
postings this is pure function work: one new RPC plus its MCP wrapper, no DDL.

**2. The dedup pattern already ships in this repo — twice.** Requirement 2 is
not a new convention here:

- `schedule_interview` (migration 021) find-or-creates on
  `(application, scheduled_at, interview_type)` and returns
  **`created: true | false`** so the caller can tell "booked" from "already on
  the books."
- `promote_suggestion`'s posting branch find-or-creates the apply task and
  returns the existing row rather than inserting a duplicate.

This matters for the spec: the requirement proposes a `matched_existing: true`
flag, and the repo already ships `created: false` for exactly this. **Pick one
and standardize** — adding a third spelling is the problem this document exists
to solve. `created` is the shipped one; `matched_existing` reads better. Either
is fine, but decide before the second implementation.

**3. `crm_update_contact` is a sound reference model.** Confirmed shape: `id`
required, every other field optional, *"only the fields you provide are
changed."* Its `notes` is documented as *"Replace notes with new content"* and
`tags` as *"Replace tags"* — matching the replace-don't-append decision below,
so standardizing on it doesn't require re-litigating semantics.

---

## Requirement 1 — generic partial-update tool

A shared "update by id" capability usable for any entity (job postings,
contacts, vendors, organizations, household items, pets, locations), not a
bespoke tool per table.

### Behavior

- Identify the record by its id (`job_posting_id`, `contact_id`, `vendor_id`, …).
- Only fields explicitly passed are changed; omitted fields are left as-is.
- Return the full updated record, plus any recomputed derived values — for
  job-hunt, `priority_score` when `salary_*` / `location` / `remote_policy`
  changes. (`set_priority_signals` already returns `compute_priority(...)` on
  every call, so this is a consistency requirement, not a new capability.)
- Fail clearly, not as a silent no-op, when the id matches no row.
- Follow `crm_update_contact`'s shape rather than inventing a new one.

### Open question — how do you *clear* a field?

"Omitted fields are left as-is" is unambiguous for setting a value. It doesn't
say how to null one back out, and the obvious implementation forecloses it.

`set_priority_signals` uses `COALESCE(p_arg, existing)`, under which `NULL` and
"omitted" are indistinguishable — so **a value can be set and changed but never
cleared**. Applied to postings, that means a `closing_date` entered by mistake
is permanent, and a wrong `salary_max` can only be overwritten, never removed.

`crm_update_contact` already solves this: `follow_up_date` is typed
`string | null`, documented as *"or null to clear."* Adopting that per-field
nullable-union convention is the smaller change and keeps the reference model
intact. Worth settling explicitly — it's a schema-level decision that's
painful to retrofit once callers exist.

### Reference instance: job posting fields

| Field | Type | Notes |
|---|---|---|
| `job_posting_id` | string (required) | UUID of the posting to update |
| `title` | string | Correct a mis-entered or updated title |
| `location` | string | Posting-specific location |
| `remote_policy` | enum: `remote` / `hybrid` / `onsite` | Column CHECK already enforces this |
| `salary_min` | number | `INTEGER` in schema |
| `salary_max` | number | `INTEGER` in schema |
| `salary_currency` | string | Column already defaults to `USD` |
| `requirements` | array of strings | Replaces the existing array |
| `nice_to_haves` | array of strings | Replaces the existing array |
| `notes` | string | Replaces existing notes wholesale — see Decisions |
| `posted_date` | string (`YYYY-MM-DD`) | `DATE` in schema |
| `closing_date` | string (`YYYY-MM-DD`) | `DATE` in schema |
| `url` | string | For when the original link was wrong or expired |

`career_trajectory`, `experience_alignment`, and `growth_stage` stay on
`set_priority_signals` — not duplicated here — but both tools must compute and
return `priority_score` the same way.

### Example

1. Navan "Sr. Manager, Analytics" intaken with no salary data.
2. Pay range later found: $122,400–$272,000.
3. Today: no way to attach it without leaving the posting blank or creating a
   duplicate via `intake_role`.
4. With the generic update tool:

```
update_posting(
  job_posting_id: "2d208f45-2d6d-41cb-b79c-c99b9b9c694a",
  salary_min: 122400,
  salary_max: 272000
)
```

### Decisions

- **Notes replace, not append**, across every entity type this touches. The
  data is slowly-changing enough that history isn't needed. If something has
  changed enough to need history, it's a new record, not an edit.
- **Foreign keys are not editable via the generic update** (e.g.
  `organization_id` on a posting). Out of scope for v1 — re-parenting is rare
  enough to handle directly if it comes up.

---

## Requirement 2 — duplicate detection on "add new" tools

A firm requirement, not a nice-to-have: it's the other half of the gap. Any
"add a new X" tool — starting with `intake_role`, extending to
`org_find_or_create` and the create paths for contacts, vendors, and household
items — checks for an existing matching record before inserting.

- **For `intake_role`:** look for an existing **open** posting with a matching
  `organization_name` (case-insensitive) and the same or substantially similar
  `title`. The org half already works this way — `intake_role` find-or-creates
  the organization case-insensitively — so this extends an existing behavior
  one level down rather than introducing a new one.
- **On a likely match, don't silently insert.** Either return the existing
  record with a match flag so the caller can follow up with the generic update
  tool, or require an explicit `force_new: true`. (Flag name: see Verified #2 —
  reuse `created` / `matched_existing`, don't mint a third.)
- **"Substantially similar" can start simple** — case-insensitive exact match
  or a basic fuzzy/substring check. v1 only needs to catch the obvious re-add.
- **Closed or filled records must not block a new entry.** A role can
  legitimately be reposted later as a distinct record. `schedule_interview`
  already precedents this exact carve-out, skipping `cancelled` rounds so a
  re-booked round creates a fresh row instead of resurrecting a dead one.
- **Implement once as a shared utility** (fuzzy/case-insensitive name match +
  existing-record flag) that any server's create tools can call.

---

## Goal

Every "add a new X" across the app gets dupe-checking for free, and every entity
gets a consistent "edit by id" — instead of each MCP server inventing its own
bespoke version of either.

---

## Relationship to the interviews backlog

Three items in [`interviews-backlog.md`](interviews-backlog.md) are the same
problem seen from inside job-hunt:

- **T1.1 (duplicate interview merge)** is Requirement 2 applied to a table
  where the duplicates already exist. The guard shipped in migration 021
  prevents new ones; the merge tool cleans up the backlog. If a shared dedup
  utility lands first, T1.1's detection half should use it.
- **T1.6 (intake a role from a JD link)** is the surface most likely to
  *create* duplicates once it exists — pasting a link for a role already
  tracked is the obvious re-add case. It should call the dedup path from day
  one rather than shipping and being retrofitted.
- **T2.2 (idempotent calendar import)** is the same shape again: a bulk create
  path that needs a natural key.

Sequencing suggestion: Requirement 2's shared utility before T1.6, since T1.6
is a new duplicate-producing surface. Requirement 1 is independent of both.
