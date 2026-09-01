# Requirement — edit an existing interview round's logistics

Status: **scoped, awaiting build** · Owner: Hannah · 2026-08-03

Instance of Requirement 1 in
[`record-update-and-dedup.md`](record-update-and-dedup.md) — that doc scoped
job postings ("Job-hunt is the first concrete instance, not the scope") and
didn't cover `interviews`. This is the same gap, found live.

---

## Problem

Found while correcting the tracker: the Cityblock Health final round (in
person, CTO Alberto, Thu 8/6 4pm, Brooklyn — interview id
`b921cd8a-92cf-406d-af80-4cc848ea4de5` on application
`e2b3e267-c4f5-4629-8f0e-cb0f9fd50cf3`) is logged with `interview_type =
'technical'`. The application's own `notes` field correctly says *"FINAL
ROUND: in-person interview with CTO Alberto…"* — the round was mistyped at
intake, not misunderstood.

**There is no supported way to fix it, in chat or in the UI.** Once a round
exists, `interviews.interview_type` is write-once:

| Tool | What it can touch on an existing round |
|---|---|
| `schedule_interview` | Nothing on a match — find-or-create only. Re-calling with the same `application_id` + `scheduled_at` but a different `interview_type` doesn't update the row; the natural key (`application_id, scheduled_at, interview_type`, `functions.sql:938-948`) no longer matches, so it INSERTS A SECOND ROW instead of correcting the first. Same time slot, two interviews. |
| `complete_interview` (wrapped by `log_interview_notes` / the UI's Done… / Edit debrief… controls) | `status`, `rating`, `feedback`, `advance_decision`, `decision_notes` only (`functions.sql:991-1060`). Deliberately the *post-round debrief* surface — it has no `p_interview_type` argument at all. |

The UI has the same hole. `ScheduleInterviewForm` (used both for "+ Schedule
interview…" and, per the interviews backlog, nowhere as an edit control) only
ever calls `scheduleInterview()` — create semantics, same find-or-create RPC.
There is no "Edit round…" affordance on an upcoming interview card anywhere in
`Interviews.tsx` or `RoleDetail.tsx`; the only in-place edit that exists today
is `InterviewOutcome` (T1.4), and that's scoped to the same debrief fields as
`complete_interview` — it doesn't touch type, schedule, duration, or
interviewer either.

So today, correcting a mistyped round has exactly one honest path: cancel the
wrong row and reschedule (losing whatever notes/prep were attached to it, per
`interview_prep_sessions.interview_id UNIQUE` + `ON DELETE CASCADE`), or leave
it wrong.

---

## Verified against the repo

**No migration needed.** Every field this touches already exists on
`interviews` (`schema.sql:153-201`): `interview_type`, `scheduled_at`,
`duration_minutes`, `interviewer_contact_id`, `category`, `notes`. This is
pure function work, same shape as Requirement 1's finding for postings.

**The reference model is `complete_interview`, not `crm_update_contact`.**
Requirement 1 pointed at `crm_update_contact` generically; for this table the
closer sibling already lives in this file — `complete_interview` is a
partial-update RPC over the *other* half of the same row (debrief fields,
`COALESCE(p_arg, existing)` per field, explicit not-found `RAISE EXCEPTION`).
The new function should be its logistics-side twin, not a reinvention.

**Scope boundary: pre-interview logistics, not outcome.** `complete_interview`
already owns `status` / `rating` / `feedback` / `advance_decision` /
`decision_notes` — don't duplicate that surface. This requirement covers the
fields you'd get wrong or need to correct *before* the round happens:
`interview_type`, `scheduled_at`, `duration_minutes`, `interviewer_contact_id`,
`category`, `notes`.

---

## Requirement — `update_interview`

### RPC (`functions.sql`)

```
update_interview(
    p_interview_id uuid,
    p_interview_type text DEFAULT NULL,
    p_scheduled_at timestamptz DEFAULT NULL,
    p_duration_minutes integer DEFAULT NULL,
    p_interviewer_contact_id uuid DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
) RETURNS jsonb
```

- Identify the row by `p_interview_id`; `RAISE EXCEPTION` if it doesn't exist
  or isn't owned by `p_user_id` — same failure shape as `complete_interview`
  (`functions.sql:1027-1029`), not a silent no-op.
- Only fields explicitly passed change. **Do not use bare `COALESCE(p_arg,
  existing)`** the way `complete_interview` and `schedule_interview`'s
  fill-in-blanks branch do — that convention can set and change a field but
  never clear it back to NULL, which `record-update-and-dedup.md` already
  flagged as an open problem for postings. Same fix applies here: a sentinel
  or nullable-union convention per field, so e.g. `interviewer_contact_id` can
  be explicitly cleared if a round turns out to have no single interviewer.
  `p_interview_type` in particular should validate against the same CHECK
  list `schedule_interview`'s Zod enum already encodes, and raise a named
  error rather than surfacing the raw constraint violation.
- Re-validate `interviews_application_or_org` isn't at risk — this function
  never touches `application_id` / `organization_id` (re-parenting a round to
  a different application/org is out of scope here, same call Requirement 1
  made for postings' `organization_id`).
- Return the full updated row: `RETURN jsonb_build_object('success', true,
  'interview', to_jsonb(v_interview));`.

### MCP wrapper (`job-hunt-mcp/index.ts`)

`update_interview({ interview_id, interview_type?, scheduled_at?,
duration_minutes?, interviewer_contact_id?, category?, notes? })` — thin
wrapper over the RPC, same pattern as `handleScheduleInterview` minus the
calendar-bridge branch (out of scope; see Open question below). Register
alongside `schedule_interview` / `log_interview_notes` in the interviews
section of the tool list.

### UI

An "Edit…" control on the Upcoming interview card (`Interviews.tsx`) and on
`RoleDetail.tsx`'s interview list, reusing `ScheduleInterviewForm`'s fields
(kind/type/date/time/duration/interviewer/notes) but wired to
`update_interview` instead of `scheduleInterview` when editing an existing
row rather than adding one. Concretely: give the form an optional
`interviewId` + initial values prop; when set, render "Save changes" and call
the update path instead of the create path. This is the same component in
edit mode, not a second form — the field set is identical.

---

## Open question — the calendar bridge

`interviews.event_id` links to a row in `events` (family-calendar week view).
`schedule_interview`'s MCP wrapper creates that event at booking time
(`handleScheduleInterview`, `index.ts:171-256`). If `update_interview` changes
`scheduled_at` or `duration_minutes` on a round that already has an
`event_id`, should it also update the linked `events` row, so the calendar
doesn't silently drift from the tracker? Cheapest correct answer: yes, mirror
the changed fields onto the linked event when `event_id IS NOT NULL`, in the
MCP wrapper (same layer that owns the create-side bridge today) rather than
in SQL. Flagging rather than deciding — worth a moment's thought before
building, not after.

---

## Example — the case that surfaced this

```
update_interview({
  interview_id: "b921cd8a-92cf-406d-af80-4cc848ea4de5",
  interview_type: "final"
})
```

Corrects the Cityblock round in place — no duplicate row, no lost prep
session, no re-typing the notes that are already right.

---

## Relationship to other docs

- [`record-update-and-dedup.md`](record-update-and-dedup.md) — the
  cross-cutting pattern this instantiates. Worth folding `interviews` into
  that doc's "Reference instance" table once this ships, so future entities
  don't miss it the way this one did.
- [`interviews-backlog.md`](interviews-backlog.md) — T1.1 (duplicate merge)
  is the cleanup path for rounds already duplicated by the workaround this
  doc replaces (cancel-and-reschedule, or the `schedule_interview` mismatch
  above); `find_duplicate_interviews` / `merge_interviews` stay the fix for
  any duplicates that exist by the time this ships.
