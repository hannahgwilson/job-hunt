# Backlog — Interviews: completion, dedup, and what's still half-built

Status: **v2 shipped** ([PR #21](https://github.com/hannahgwilson/job-hunt/pull/21))
· Owner: Hannah · 2026-07-27, updated 2026-07-31

Everything below marked ✅ was built on this branch, exercised in the running
app as demo@jobhunt.test, and re-verified against the live database after
`migrations/022_interviews_v2.sql` was applied on 2026-07-31. Edge functions
deployed: `intake-from-url` (new), `interview-prep` (D5 context),
`job-hunt-mcp` (new `list_interviews` tool).

| | |
|---|---|
| ✅ Fixed | D1, D2, D3, D4, D5 (SQL path), D7 |
| ✅ Built | T1.1, T1.2, T1.3, T1.4, T1.5, T1.6 (prefill), T1.7, T2.1, appendix commit |
| ⏳ Still open | **D8** (found during this build — see below), T1.6's required Open Brain notes write (ownership decision), D6 backfill (waits on T2.3), T2.2, T2.3, Tier 3 (incl. new T3.3 — split Interviewing column, drop Accepted) |
| ⚠️ Check | the unique index installs only when the DO block finds no duplicates — if the SQL editor printed the NOTICE, merge (Interviews → Past → Duplicate rounds) and re-run 022 |

Written after shipping the interview-debrief work
(`8703dd1`, migration 021). That change added the ability to mark a round
completed and stopped `schedule_interview` from minting duplicates. This
document records what it deliberately left undone, the defects the follow-up
scan turned up, and the items raised in review afterwards.

Everything below was verified against the repo and the live database at the
time of writing — the "Evidence" lines are the checks, not assertions.

The Tier 1 items have **not** been verified end-to-end in a running app: the
tracking hub is behind a magic-link login, so the debrief controls shipped in
`8703dd1` are typecheck- and build-clean but unexercised. Worth a manual pass on
one round before trusting the "Mark all completed" sweep on a backlog.

---

## Schema state — applied 2026-07-27

`020_networking_calls.sql`, `020_stage_roles.sql` and
`021_interview_completion.sql` have all been applied to the deployed database,
via a combined script run in the Supabase SQL editor. Tier 1 is unblocked.

Recorded because the failure mode was non-obvious and will recur: migration 020
was merged to `main` with its frontend but never applied, so the Interviews tab
died with *"Could not find a relationship between 'interviews' and
'organization_id' in the schema cache"* — PostgREST could not resolve the
`organizations:organization_id` embed in `fetchInterviews` against a table that
had no such column. **The frontend shipped; the schema didn't.** Nothing in the
repo catches that drift today.

**The ordering trap, for anyone rebuilding this script:** the networking branch
and the dedup work both rewrote `schedule_interview`, and the merged definition
(carrying `p_organization_id` / `p_category` *and* the find-or-create dedup)
lives only in `functions.sql`. Migration 021 deliberately contains only
`complete_interview` so the two migrations don't fight over one
`CREATE OR REPLACE`. Concatenating the three migration files naively produces a
`schedule_interview` with no networking support.

> Two migrations are both numbered **020** (`020_networking_calls`,
> `020_stage_roles`), one from each parallel branch. They don't conflict —
> different tables — but "which 020 is applied?" is now ambiguous, and that
> ambiguity is plausibly how this one got skipped. Worth settling a convention
> before the next pair of branches.

---

## Defects

D1-D4 came from the post-ship scan; D5-D6 were raised in review; D7 surfaced while scoping T1.7.

### D1 — `advance_decision` is inert — ✅ fixed by T1.2 (migration 022)

The go/no-go is written by the MCP's `log_interview_notes` and by the new
debrief control, and rendered as a pill on two pages — but **nothing reads it**.
It feeds no funnel metric, drives no application status, and appears in no
queue. Mark a round `rejected` and the application sits at `interviewing`
indefinitely.

CLAUDE.md bills this as "the explicit *do I move forward?* call the requirements
asked for." Today it is decorative.

*Evidence:* every non-write reference to `advance_decision` across `*.sql`,
`*.ts`, `*.tsx` is either a column definition, a form binding, or a display pill.

### D2 — Networking calls pollute interview analytics — ✅ fixed by T2.1 (migration 022)

`get_stage_roles` rolls up interviews per application with **no `category`
filter**, so a networking call attached to an application inflates
`interviews_completed` / `interviews_pending` and can win `furthest_round`.
`get_action_queue.upcoming_interviews` has the same gap.

*Evidence:* the `iv` CTE is `FROM interviews WHERE user_id = p_user_id GROUP BY
application_id` — no category predicate. Same for the action queue's
`upcoming_interviews` sub-select.

### D3 — Migration 020 documents an invariant it doesn't enforce — ✅ fixed by T2.1 (migration 022)

020's header states the synthesis / story-cheat-sheet flow "stays scoped to
`category = 'interview'` rows — see `get_story_cheat_sheet` in functions.sql".
`get_story_cheat_sheet` has no such filter. It works by accident: networking
calls rarely have an `interview_prep_sessions.synthesis` row to join to.

### D4 — Networking calls (and interview types) can't be created from the UI — ✅ fixed by T1.3

The table, the RPC, the list query, the card styling and the Upcoming legend all
support `category = 'networking'` — but no write path passes `p_organization_id`
or `p_category`. The grid advertises a feature reachable only from chat.

`interview_type` has the same problem: `ScheduleInterviewForm` collects date,
time, and notes only, so every round created through the app is untyped. That
leaves `furthest_round` null and makes the new dedup natural key coarser than it
should be.

### D5 — Prep sessions ignore the context captured at scheduling time — ✅ fixed (both halves)

> **Shipped 2026-07-28:** `start_interview_prep` defaults `intake_notes` to
> `interviews.notes` on first insert (migration 022); `get_interview_prep_session`
> returns the scheduling notes on the `interview` object, the prep page
> pre-fills a fresh intake box from them, and `contextSeed()` folds them into
> the model prompt (deduped when the intake was seeded from them verbatim).
> The multi-interviewer modelling limit below remains open.

*Reported: "the context I've shared for individual interviews — competencies
tested, people I'm meeting with, notes — is not populating on the prep session.
I have to try twice."*

`interviews.notes` is where scheduling actually puts this. Live rows read, e.g.:

> *"Product Team round. Interviewer: Irene Duett, Principal Product Manager.
> Competencies: Strategic Thinking & Impact; Product Analytics Acumen."*

**The prep flow never reads that column.** `get_interview_prep`'s `iv` CTE
selects `i.id, i.interview_type, i.scheduled_at, i.status,
i.interviewer_contact_id` — no `i.notes` — and the returned `interview` object
carries only type/schedule/status. `contextSeed()` in the `interview-prep` edge
function builds the model prompt from `session.intake_notes` alone.

So the competencies and interviewer names you captured at scheduling are
invisible to the AI unless you retype them into the intake box. That is the
"try twice": the box renders empty on a fresh session
(`InterviewPrepPage.tsx:23` seeds `intakeDraft` only when a session with notes
already exists), so the first run produces an ungrounded brief.

There is a `'notes'` key in the prep payload, but it is Open Brain *company*
thoughts nested under `company_intel` — unrelated, and easy to mistake for this.

**Fix:** seed the prep context from `interviews.notes` — either by having
`start_interview_prep` default `intake_notes` to it on first insert, or by
passing it through `get_interview_prep` and appending it in `contextSeed`. The
former also fixes the empty-textarea symptom.

> **Related modelling limit, worth deciding on here.** `interviews` has a single
> `interviewer_contact_id`, but real rounds have panels — one live row reads
> *"Interviewers: Samantha Wilkes (Sr. Data Analyst, Engagement) & Revati
> Khopkar (Sr. Data Analyst, BI)"*, both names stuffed into free text because
> there is nowhere else to put them. Structured multi-interviewer support would
> need an `interview_interviewers` join table.

### D6 — Story library renders legacy stories as undifferentiated text — ⏳ open (backfill waits on T2.3)

> **Renderer note:** the shared `<StoryCard>` (T1.7) now falls back to the
> legacy `story` blob wherever stories render, so old rows show their text
> rather than nothing — but the blobs still have no STAR structure. The LLM
> backfill remains bundled with T2.3.

*Reported: "the formatting is just blocks of text which is not helpful."*

`InterviewPrepStory` carries both shapes: `situation` / `task` / `action` /
`result`, **and** a legacy `story` blob, commented in `types.ts` as
"pre-STAR-split". The library renders the STAR `<dl>` when those fields exist and
falls back to `<p>{story.story}</p>` otherwise.

Sessions synthesized before `bedfe50` ("Rework interview-prep coaching: STAR
breakdown…") only have the blob, so the library is a mix of structured cards and
wall-of-text paragraphs depending on when each session was run. Fixing the
renderer alone won't help — the legacy rows have no structure to render. They
need backfilling (an LLM pass splitting the blob into STAR), which makes this a
natural companion to T2.3.

### D7 — The prep page renders story bodies blank, and copies them as "undefined" — ✅ fixed by T1.7

> **Shipped 2026-07-28:** the prep page renders the shared `<StoryCard>`, and
> `copyMarkdown` uses `storyMarkdown()` (same component file) which emits the
> STAR fields with the blob fallback — verified the copied text end-to-end.

Found while scoping **T1.7**. Both story renderers on `/interview-prep/:id` read
`s.story` — the **legacy** single-blob field:

```tsx
// InterviewPrepPage.tsx:259 — rendered list
<li><strong>{s.title}</strong> — {s.story}{s.best_for && …}</li>

// InterviewPrepPage.tsx:70 — copyMarkdown
`- **${x.title}** — ${x.story}${x.best_for ? ` _(for: ${x.best_for})_` : ""}`
```

The synthesis tool schema in the `interview-prep` edge function no longer emits
that field. Its story properties are `title`, `competency`, `situation`, `task`,
`action`, `result`, `best_for`, with
`required: ["title", "competency", "situation", "task", "action", "result"]` —
and **no `story`**.

So for every session synthesized since `bedfe50`:

- the rendered list shows the title, an em-dash, and nothing after it;
- **`copyMarkdown` emits the literal string `undefined`**, because `${x.story}`
  interpolates `undefined` into the template. Anyone who has copied a prep sheet
  out of the app has pasted `- **Title** — undefined`.

The STAR content is sitting in the object the entire time and simply isn't read.
T1.7's shared card fixes the rendered list; `copyMarkdown` needs the same
treatment separately, since it builds a string rather than JSX.

Related to **D6** — the library falls back to `story` for *older* rows that
genuinely have no STAR fields. The two are opposite ends of the same transition:
D6 is old data missing new fields, D7 is new data read through an old field.

### D8 — Open Brain thoughts leak across auth users (found 2026-07-28)

Signed in as **demo@jobhunt.test**, the Action Queue's "From Open Brain"
suggestions showed the real account's job-search notes (companies, a named
contact's candid intel). Three `SECURITY DEFINER` functions read `thoughts`
with **no owner predicate** — `get_suggestions`, `get_interview_prep`
(company_intel.notes), `get_interview_prep_session` (ob_suggestions) — and
`promote_suggestion` UPDATEs a thought's status by id, also unscoped, so
another signed-in user can both read and mutate them.

The root cause is structural: **`thoughts` has no owner column at all**
(probed via PostgREST: `user_id`, `owner_id`, `created_by`, … all 42703).
Open Brain is single-user by construction, and these readers use
`SECURITY DEFINER` precisely to cross into it — so any *other* authenticated
user of this database inherits the same view. This contradicts the README's
"another signed-in user would see only their own rows."

Not fixed in v2 because the clean fix is an Open Brain schema decision (add an
owner column + RLS there, then scope these four functions), which is the same
cross-system ownership question T1.6's notes-write raised. Until then: don't
hand demo credentials to anyone who shouldn't read the real notes.

---

## Tier 1 — finish what's half-built

### T1.1 Duplicate review & merge, then the `UNIQUE` index — ✅ shipped

> **Shipped 2026-07-28:** `find_duplicate_interviews()` (groups on the natural
> key, best-keeper-first ordering: has synthesis > has prep > oldest) and
> `merge_interviews(p_keep_id, p_merge_ids)` in migration 022 + functions.sql,
> with a review panel on Interviews → Past that appears only when groups
> exist. The merge fills keeper blanks, re-points prep sessions and tasks,
> deletes a dupe's redundant calendar event, and **refuses** when both copies
> carry a prep session. The `UNIQUE` index is in the same migration inside a
> conditional DO block — it installs only once no duplicates remain, so re-run
> 022 after merging if the NOTICE fired.

Migration 021 guards against *new* duplicates but leaves existing ones in place,
and deliberately ships **no** `UNIQUE` index — creating one would fail against
the current data.

Build a `find_duplicate_interviews()` read function feeding a review card:
group the collisions, show what's attached to each copy, keep one and merge the
rest via a `merge_interviews` RPC. Then add the partial unique index on
`(application_id, scheduled_at, interview_type)` where `scheduled_at IS NOT NULL
AND status <> 'cancelled'`.

**This must be a reviewed merge, not a blind `DELETE`.** Two cascades make the
naive version destructive:

- `interview_prep_sessions.interview_id` is `ON DELETE CASCADE` with a `UNIQUE`
  constraint — deleting the wrong copy of a pair silently destroys its prep work.
- `interviews.event_id` is `ON DELETE SET NULL` *on the events side only*.
  Deleting an interview leaves its calendar event orphaned in the week view.

### T1.2 Wire up `advance_decision` (fixes D1) — ✅ shipped

> **Shipped 2026-07-28**, in `complete_interview` (migration 022). Decisions
> made: the cascade fires only on an *explicit* `rejected`/`withdraw` in the
> call (never the COALESCEd stored value), only on `status='completed'`, only
> for `category='interview'`, and only when the application is live; `advance`
> never auto-bumps the application. **A `rejected` on ANY round terminates the
> application** — "they passed" read as a verdict on the application, not the
> round; flag if per-round semantics are wanted instead. `hold` rounds surface
> in `get_action_queue.interview_decisions` + an Action Queue card.

`rejected` / `withdraw` on a round cascades to the application status through
`advance_application`, so the existing status-history trigger logs the
transition. `hold` surfaces in the action queue as a decision owed. Decide
explicitly whether a non-final round's `rejected` should terminate the whole
application or only that round.

### T1.3 Full schedule form (fixes D4) — ✅ shipped

> **Shipped 2026-07-28:** kind (interview/networking, with type lists split
> accordingly), type, date/time, duration, and an interviewer picker (fetches
> the org's contacts lazily; hidden when there are none). The form now also
> takes `organizationId` — the Company page mounts it as "+ Log a networking
> call…", closing the networking gap. Dedup guard surfaces "already on the
> books" instead of silently no-oping.

Extend `ScheduleInterviewForm` to collect interview type, category, duration,
and interviewer contact. Closes both UI gaps in one component and makes
networking calls creatable. The RPC already accepts every one of these
parameters — this is purely a client-side gap.

### T1.4 An "old interviews" view — manage finished rounds — ✅ shipped (both halves)

> **Shipped 2026-07-28:** Interviews → **Past** sub-tab — finished rounds
> newest-first with rating / `advance_decision` / feedback, searchable,
> editable in place ("Edit debrief…" keeps the terminal status; Reopen
> restores `scheduled`), and hosting the T1.1 duplicates panel. The "cheap to
> do both" call was taken: a `list_interviews` MCP tool (status / category /
> only_past filters) covers past rounds from chat.

*Requested: "the new Interviews tab is great. I want an 'old interviews' where I
can use the MCP to clean up, log notes and mark things completed / finished. We
had a version of this before I merged that lost changes to the UI."*

Correct — this regressed in the merge. The pre-merge Interviews page split
Upcoming / **Needs debrief** / **Past**. The merged tab kept Upcoming and Needs
debrief but dropped Past entirely.

The result: **a round vanishes the moment you complete it.** It leaves Upcoming
(filtered to `status === 'scheduled'`), leaves Needs debrief (same filter), and
survives only inside the Prep sub-tab's chronological list — which is organised
around prep documents, not outcomes, and offers no way to revisit or amend a
verdict. The debrief controls shipped in `8703dd1` are therefore one-way: you
can close a round out, but you can't get back to it except through the Prep tab.

Scope:

- A **Past / Completed** sub-tab or section listing `status <> 'scheduled'`
  rounds, newest first, showing rating, `advance_decision`, and feedback.
- Editable in place — amend notes, change rating, correct a mis-clicked outcome.
  `complete_interview` already supports all of this (including `Reopen`, which
  writes `status = 'scheduled'`); the surface to reach it is what's missing.
- Bulk cleanup affordances, since this doubles as where the existing duplicate
  backlog gets triaged. Coordinate with **T1.1** — that's the same screen.

Worth confirming before building: "use the MCP to clean up" may mean you want to
drive this conversationally rather than by clicking, in which case the gap is
MCP read tools for *past* rounds (there is `get_upcoming_interviews`, but no
`list_interviews` covering completed ones) rather than a UI. Cheap to do both;
they share nothing.

### T1.5 Show current application status in the Stage funnel drill-down — ✅ shipped

> **Shipped 2026-07-28:** `status` added to `get_stage_roles` rows +
> `StageRoleEntry`, rendered as a `pill pill-{status}`, terminal rows faded
> (`.row-terminal`). The design question was settled per the doc's own lean:
> **column only, no filter toggle** — the row count keeps matching the
> funnel's Total column.

*Requested: "for companies in each stage, I want to see the status of my
application."*

The Dashboard's Stage-funnel drill-down (`get_stage_roles`, added in `cadf274`)
lists six columns — role, interviews done, interviews pending, furthest round,
days since applied, days since screen — and **the application's current status
is not one of them.**

That matters more here than it would in an ordinary table, because the
drill-down is deliberately *reached-based*: per 020's header, "every application
that EVER reached a stage, not just the ones currently sitting there — so an app
now interviewing still lists under 'applied' and 'screening' too." That's the
right population (it makes each row count match the funnel's Total column), but
without a status column the table is genuinely ambiguous. Click **applied** and
you get a list mixing:

- applications still sitting at applied — the ones you'd want to chase,
- applications long since advanced to offer,
- applications rejected months ago,

with nothing distinguishing them. The stage you clicked tells you where a role
*has been*, never where it *is*.

Scope — small:

- Add `status` to the `rows` CTE and the `jsonb_build_object` in
  `get_stage_roles` (`applications.status` is already joined as `a`), plus
  `status` on `StageRoleEntry`.
- Render it as a `pill pill-{status}` — those classes already exist and are used
  for the stage heading in the same component and across the Pipeline board.
- De-emphasise terminal rows (`rejected` / `withdrawn` / `closed`), which are
  historical rather than actionable.

Design question worth settling: should the drill-down also *filter* — a
"still here" vs "moved on" toggle? Adding the column solves legibility, and
that may be enough. A filter changes what the row count means, which would break
its correspondence with the funnel's Total column — so if you want the filter,
keep the unfiltered count visible alongside it.

Independent of the rest of Tier 1; touches no interviews code.

### T1.6 Intake a role from a JD link, in the UI — ✅ prefill shipped · ⏳ Open Brain notes open

> **Shipped 2026-07-28:** `intake-from-url` edge function (server-side
> `web_fetch`, mirroring judge-growth's auth + call shape) extracts org /
> title / salary / location / remote policy / requirements and returns them —
> persisting nothing. Add Role gained a "Fetch from link" button, salary
> min/max fields for review, and passes extracted requirements + notes into
> `intake_role`. Walled pages return a readable "fill by hand" message
> (`fetch_failed` in the tool schema). Verified against a live Greenhouse
> posting. **The required Open Brain notes write below was deliberately NOT
> built** — the ownership decision (job-hunt RPC vs. Open Brain capture
> surface) is still open, now compounded by D8.

*Requested: "I want to take a link from a web posting and add it directly in the
UI — right now I can only add stuff via Claude chat."*

The gap is stated outright in the code. [`AddRole.tsx:57`](../web/src/pages/AddRole.tsx#L57)
tells the user: *"To auto-fill from a link, paste it to Claude and ask it to
intake the role."* The form has a **Posting URL** field, but it's a passive
record — nothing fetches it. Every other field is hand-typed.

This is Play 1 of [`CLAUDE.md`](../CLAUDE.md) — the enrichment step the agent
was built to own — with no UI equivalent.

**The pieces already exist.** `intake_role` handles persistence in one
transaction, and `AddRole` already fires `runJudge` after intake, so the
prioritization signals backfill themselves. What's missing is the read: fetching
the posting and extracting title, company, salary, requirements, location, and
remote policy.

Two things make this smaller than it looks:

- **The fetch must happen server-side.** Browser CORS blocks fetching arbitrary
  third-party pages from the client, so this is an edge function — not a
  client-side `fetch`.
- **There is direct precedent in this repo.** `judge-growth` already calls
  Anthropic's server-side web-search tool from an edge function
  ([`judge-growth/index.ts:34`](../supabase/functions/judge-growth/index.ts#L34)),
  so the auth, the call shape, and the deploy path are all established. A new
  `intake-from-url` function is the same pattern with the **web fetch** tool
  (`web_fetch_20260209` on current models) instead of web search.

Two constraints worth knowing before building:

- **Web fetch only retrieves URLs already present in the conversation** — fine
  here, since the user pastes the URL, but it means the tool can't go discover
  pages on its own.
- **Walled postings will fail.** LinkedIn and many ATS pages are auth-gated or
  JS-rendered. CLAUDE.md's Play 1 already anticipates this ("If the page is
  walled, ask me for the fields instead"), and the graceful fallback is the form
  that exists today. So build this as a **prefill layer over `AddRole`**, not a
  replacement for it: paste URL → fetch → populate the fields → user reviews and
  corrects → save. That also keeps the user in the loop on extraction errors,
  which matters when the extracted salary drives the comp score.

#### Required: capture the Open Brain notes (Play 1, step 3)

**UI intake must write the same two thoughts the chat play does** — one
company-level reference note (once per company) and one per-role note on why
the role is interesting. Without this, roles added through the UI are quietly
thinner than roles added through chat: the company note is what
`get_interview_prep` surfaces as `company_intel.notes` when you later prep for
an interview there, so skipping it degrades a downstream feature, not just the
record.

Three things to get right, all verified against the current schema:

**1. `thoughts` is in the same database, but this repo has no write path.**
Job-hunt functions read it freely (`get_suggestions`, `get_interview_prep`,
`get_story_cheat_sheet`) and `promote_suggestion` updates one status column —
but there is no `INSERT INTO thoughts` and no `capture_thought` anywhere in this
repo. Capture is an Open Brain MCP tool, owned by that side. So this needs a
deliberate decision, not an incidental insert:

- Add a narrow write path on the job-hunt side (an RPC, or fold it into
  `intake_role` so the org, the posting, and both notes land in one
  transaction), **or**
- Call Open Brain's own capture surface from the new edge function.

The transactional version is more attractive — intake is already
"one call, can't half-fail" — but it means this repo writing into another
system's table. Worth a moment's thought about which side should own it.
Note the entity-extraction worker that bridges a company name to its
`organizations` row lives on the Open Brain side; confirm it fires on a direct
insert before relying on it.

**2. The tags go in `metadata.topics`, not a `tags` column.** CLAUDE.md
describes the convention as tags `['job-search', '<Company>']`, but the storage
shape is a JSONB `metadata` object with a `topics` array. Both readers match on
containment:

```sql
metadata @> '{"topics":["job-search"]}'::jsonb              -- get_suggestions
metadata @> jsonb_build_object('topics', jsonb_build_array(org_name))  -- get_interview_prep
```

So `metadata.topics` must contain **both** `'job-search'` and the exact
organization name. Get the company string wrong and the note is silently
invisible to the interview-prep panel — no error, just an empty `company_intel`.

**3. Decide what `status` and `metadata.type` should be.** `get_suggestions`
pulls job-search thoughts where `COALESCE(status,'') NOT IN ('promoted','done')`
and sorts `metadata->>'type' = 'task'` first. A note captured with no status
therefore lands in the **Suggested inbox** as a promotable item. For a per-role
"why this is interesting" note that may be right; for a company reference note
it's probably noise on every single intake. Set the fields deliberately rather
than discovering the behavior after the inbox fills up.

The largest Tier 1 item — a new edge function, a thoughts write path, and UI
work, versus a column or a component for the others.

### T1.7 One story card, rendered on the prep page (fixes D7) — ✅ shipped

> **Shipped 2026-07-28** exactly per the decision below: shared `<StoryCard>`
> (styles renamed `library-*` → `story-*`), full STAR on the prep page, Prep
> sub-tab reduced to count + "Open full prep session →", library unchanged
> apart from using the shared card. `copyMarkdown` fixed separately via
> `storyMarkdown()` in the same component file.

*Requested: "the story cards outlined on the Interviews tab should show up on
[`/interview-prep/:id`]. I think part of the confusion is having both — can we
simplify?"*

#### The actual redundancy

The same `InterviewPrepStory` object renders in three places, at three
fidelities:

| Surface | Axis | Renders |
|---|---|---|
| Interviews → **Story library** | by **competency**, across all companies | Full STAR card — title, `<dl>` of Situation/Task/Action/Result, source, `best_for` footer |
| Interviews → **Prep** sub-tab | by **round** | Title + competency pill, one line |
| **`/interview-prep/:id`** → "Stories to tell" | by **round** (one round) | Title + em-dash + **nothing** — see D7 |

The confusion isn't three surfaces — it's that **rows 2 and 3 answer the same
question** ("what am I telling in this round?") at two different, both-degraded
fidelities, and row 2 exists mainly to link to row 3. The library is on a
genuinely different axis and earns its place: *"what stories do I have?"* is not
*"what am I telling on Thursday?"*

#### Decision

1. **The prep page is where you read a round's stories.** Render the full STAR
   card there — replacing the `<ul className="clean">` under "Stories to tell",
   which sits between the Prep-summary card and "Competencies to focus on".
2. **The Prep sub-tab becomes an index, not a second renderer.** Keep the
   chronological round list, the spikes/gaps panel, and "Open full prep session
   →"; drop its own inline story list (a count is enough). That removes the
   duplicate rendering rather than upgrading it — one fewer place showing
   stories differently.
3. **The Story library is unchanged.** Different axis, different job.

Net: one `<StoryCard>` component, two call sites (library + prep page), on two
different axes.

#### Implementation

The data is already identical — the library reads `session.stories` from
`get_story_cheat_sheet`, the prep page reads `session.synthesis.stories`, and
both are `InterviewPrepStory[]`. Only the markup differs. Extract the library's
card; its styles (`.library-card`, `.library-star`, `.library-card-foot`)
already exist and need only renaming out of the `library-` prefix.

**`copyMarkdown` needs the same fix separately** — it builds a string rather
than JSX, so the shared component doesn't reach it. It is the source of the
literal `undefined` in copied prep sheets (D7).

Small: one extracted component, two call sites, one string-builder fix, and a
deletion in the Prep sub-tab.

---

## Tier 2 — correctness

### T2.1 Category-aware analytics (fixes D2 and D3) — ✅ shipped

> **Shipped 2026-07-28** in migration 022: `category = 'interview'` predicates
> in `get_stage_roles`' `iv` CTE, `get_action_queue.upcoming_interviews` (and
> the new `interview_decisions` bucket), and `get_story_cheat_sheet`.

Filter `category = 'interview'` in `get_stage_roles`, `get_action_queue`, and
`get_story_cheat_sheet` — enforcing the invariant 020 already claims.

### T2.2 Idempotent calendar import — ⏳ open

The root cause of the original duplicates was a bulk agent-driven import from
calendar invites with no natural key: four Cityblock rounds created 23 seconds
apart, re-runnable into a second copy of each. Migration 021's find-or-create
guard makes that safe *by accident of the predicate*; a first-class import path
would make it safe *by design* — preview what will be created, dedup against
what exists, then commit.

### T2.3 Consolidate the story library — reconcile, don't accumulate — ⏳ open (carries the D6 backfill)

*Requested: "there are way too many stories. I want to use an LLM to compare the
story I reference in a prep doc to the 'library', reconcile them so I have like
10–12 rather than 30."*

The library has no concept of a canonical story. `get_story_cheat_sheet` returns
`synthesis->'stories'` per session with no dedup and no limit, and
`competencyIndex()` flattens every session's array into one map. Every prep
session mints a fresh set, so the library grows linearly with sessions —
N sessions × ~10 stories. The same "led the Looker migration" story appears once
per session that surfaced it, each phrased differently, none linked.

The ask is a real inversion of the model: stories should be **a standing library
that prep sessions draw from and contribute back to**, not a by-product each
session accumulates. Concretely:

- A canonical `stories` table (or a `resume_bullets`-style dim), one row per
  distinct story, STAR-structured, tagged by competency.
- On synthesis, an LLM reconciliation pass: for each story the session produced,
  match against the library — same story, variant of an existing one, or
  genuinely new? Merge variants into the canonical row (keeping the better
  phrasing) rather than appending.
- Prep sessions then *reference* library rows instead of embedding copies, so
  "which stories did I use for Cityblock" stays answerable.
- A one-time backfill collapsing today's ~30 into the target 10–12, which is
  also the natural moment to split legacy blobs into STAR fields (**D6**).

Design question to settle first: **is a story allowed more than one competency?**
Today `story.competency` is a single optional string and the library rail is
keyed on it, so one story lives under exactly one heading. Real stories answer
several prompts ("led the migration" serves both *Influence* and *Technical
Judgment*), and a 10–12 story library only covers a full competency map if
stories are reusable across it. Many-to-many is very likely the right call, but
it changes the rail, the index, and the reconciliation prompt — so decide before
building, not after.

---

## Tier 3 — new ground

### T3.1 Debrief nudges — ⏳ open

Overdue un-debriefed rounds currently surface only in the Interviews tab's
"Needs debrief" section. They should also reach the Dashboard and the action
queue — until a round is closed out it keeps counting as `interviews_pending`.

### T3.2 Outcome analytics — ⏳ open (T1.2 dependency now met)

Ratings and go/no-go decisions across many rounds are about to become a real
dataset. Pass rate by interview type, by company growth stage, by fit score —
*which round types you actually lose at* is the most useful thing this data
could tell you, and nothing computes it today. Depends on T1.2, since
`advance_decision` is the signal.

### T3.3 Split the "Interviewing" Kanban column by round type; drop Accepted — ⏳ open

*Requested (2026-07-31): "I want to break out interviewing into hiring
manager, panel & final round. Drop accepted from the Kanban for space."*

**Today's Kanban is a 1:1 render of `applications.status`.** `PIPELINE_COLUMNS`
(`web/src/lib/types.ts:29-31`) is `applied, screening, interviewing, offer,
accepted`, and `Pipeline.tsx`'s board (`Pipeline.tsx:132-155`) just filters
`apps` by `a.status === col` per column — one column per status value, nothing
derived. `interviewing` is a single status; it isn't computed from interview
rounds at all.

That makes the split non-trivial: splitting the *column* without touching the
*status* enum (which feeds the funnel metrics, the status-history trigger, and
`STATUS_ORDER`) means the Kanban needs a second axis to bucket `interviewing`
apps by round. The natural source is each app's furthest interview round —
already computed once, elsewhere, as `furthest_round` in `get_stage_roles`
(`functions.sql:228`, best completed/scheduled `interview_type` for
`category = 'interview'` rounds per D2/T2.1) — but Pipeline's data source
(`fetchApplications`) doesn't join `interviews` today, so either that join gets
added or Pipeline switches to consuming something shaped like
`get_stage_roles`.

Two things to settle before building:

- **Interview type coverage is wider than three buckets.** The `interview_type`
  CHECK constraint (`schema.sql:176-179`) is `phone_screen, technical,
  behavioral, system_design, hiring_manager, team, final` — `hiring_manager` and
  `final` exist verbatim, but there's no `panel`; the closest value is `team`
  (rename the label only, or migrate the constraint to add `panel`). And the
  four earlier types (`phone_screen`, `technical`, `behavioral`,
  `system_design`) have no obvious column — fold them into a generic
  "Interviewing" bucket that precedes the three named ones, or into whichever
  named column comes first, rather than dropping them silently.
- **Where do `accepted` apps go once the column is gone?** `accepted` is also
  in `STATUS_ORDER` and the funnel — dropping it from `PIPELINE_COLUMNS` only
  removes it from the board, not the data model. Give it a landing spot
  (mirroring how `rejected`/`withdrawn` already collapse into the "Rejected
  applications" section, and closed postings into "Closed roles") rather than
  making accepted offers simply invisible on Pipeline.

---

## Appendix — unrelated: recovered orphan commit `94bc031` — ✅ taken (guard widened)

> **Shipped 2026-07-28** in `submit_application` (migration 022), with the
> change this section argued for: the `IF v_app.status = 'applied'` guard is
> widened to any non-`draft` status. (It did ride the Tier-1 branch after all —
> one migration was chosen over two to avoid another two-020s incident.)

**Not an interviews item.** Parked here because it was found during the
worktree cleanup that produced this document and would otherwise be lost — it
sits alone on `hw_c/objective-bardeen-c2e3cb`, never merged, dated 2026-07-06.

> *Auto-complete the Apply checklist task when an application is submitted*
> — 13 lines in `submit_application`, `functions.sql` only.

### Still needed?

Yes, but for a narrower case than when it was written. Nothing in current `main`
closes an apply task on submission: `submit_application` doesn't touch `tasks`,
and the only other `kind = 'apply'` reference is `promote_suggestion`, which
*creates* these tasks and never closes them.

What has changed since is that the **suggestion inbox** became self-healing.
`get_suggestions`' roles bucket is fed by `get_prioritized_roles`, which only
returns postings with no live application — so applying now removes a role from
*suggestions* on its own. That splits the original problem in two:

| Case | Today |
|---|---|
| Role never promoted to a task | Drops out of suggestions on apply — **already handled** |
| Role explicitly starred onto the checklist | Task stays `open` indefinitely — **still broken** |

`get_job_checklist` filters on `t.status` alone with no join to `applications`,
so the checklist is the surface that still goes stale — and only for tasks you
deliberately added, which are the ones most likely to be noticed.

### Does it still apply?

Yes. Cherry-picks with no conflict onto current `main`, landing correctly right
after `RETURNING * INTO v_app;` in the since-rewritten `submit_application`.
Every column it touches is live: `job_posting_id` (migration 016),
`completed_at`, and the `status IN ('open', 'snoozed')` idiom used in five other
places in `functions.sql`.

### Change it before taking it

The commit guards with `IF v_app.status = 'applied'`, and `submit_application`
takes `p_status` defaulting to `'applied'`. The commit message frames the guard
as deliberate ("not e.g. a directly-logged later stage") — but it reads
backwards: logging a role directly at `screening` means you unambiguously
applied, yet the apply task stays open. Every path through this function creates
an application for a posting that was applied to, so the guard protects against
nothing. **Drop the `IF`, or widen it to any non-`draft` status.**

Keep this off the Tier 1 branch — it shares no code with the interviews work.

---

## Related

- [`record-update-and-dedup.md`](record-update-and-dedup.md) — the cross-cutting
  update-by-id + duplicate-detection pattern. T1.1, T1.6 and T2.2 are all
  instances of it; see that doc's closing section for sequencing.
- [`CLAUDE.md`](../CLAUDE.md) — Play 2 covers the interview lifecycle
- [`migrations/021_interview_completion.sql`](../migrations/021_interview_completion.sql)
- [`migrations/020_networking_calls.sql`](../migrations/020_networking_calls.sql)
- [`functions.sql`](../functions.sql) — canonical `schedule_interview` /
  `complete_interview`
