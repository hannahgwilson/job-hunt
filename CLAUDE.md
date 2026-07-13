# CLAUDE.md — Running the job search with Claude

This file tells an AI assistant (Claude, etc.) how to drive the job search using
the deployed MCPs. The repo's tables and tools are the *system*; these are the
two repeatable *plays* that operate it. The tracking-hub UI reads the same data,
but **writes are easiest to do here, in conversation.**

## The model in one breath

- **Companies** → `organizations` (shared dim). **People** (recruiters, hiring
  managers, referrers) → `contacts` (shared dim) with CRM history. **Roles,
  applications, interviews, funnel** → the job-hunt tables.
- The agent's unique job is **enrichment** (read a JD link, extract the fields).
  **Persistence is one transactional RPC** (`intake_role`) — never chain inserts.

## Tag conventions (keep these consistent — everything queryable depends on it)

| Entity | Tag(s) | Meaning |
|---|---|---|
| `organizations` | `employer-target` | a company I'm pursuing |
| | `past-employer`, `agency`, `client` | other relationships |
| `contacts` | `professional`, `job-hunt` | someone in the search (recruiter, referrer, interviewer) |
| | `job-hunt`, `prospect` | found via the tracking hub's "Find hiring manager" LinkedIn search launcher, not yet confirmed — `save_prospect_contact` / `promote_prospect_contact` |
| `thoughts` (Open Brain) | `job-search`, plus the company name | notes about a company or role |

## Play 1 — Intake a role (requirements 1 & 2)

When I paste a job-description link (or describe a role):

1. **Enrich.** Read the posting at the URL and extract: title, salary range,
   key requirements, location, remote policy, source. If the page is walled,
   ask me for the fields instead. **Also judge the three prioritization signals**
   (see Play 4) by reading the JD against my resume — call `get_resume` to fetch
   the stored long-form version (I upload it from the tracking hub's Resume page;
   `resume/resume.example.md` is only the committed placeholder).
2. **Persist in one call** — job-hunt `intake_role`:
   ```
   intake_role({
     organization_name: "Anthropic",     // found case-insensitively or created
     title: "Senior AI Engineer",
     url: "<the link>",
     salary_min, salary_max, requirements: [...],
     location, remote_policy, source: "linkedin",
     // prioritization signals (optional but recommended — they rank the queue):
     experience_alignment: 0.85,          // 0..1 fit vs my resume
     career_trajectory: "step_up",        // step_up | lateral | step_back
     growth_stage: "growth"               // seed | early | growth | late | public | unknown
   })  →  { organization_id, posting_id }
   ```
   This find-or-creates the org (tagged `employer-target`) and inserts the
   posting transactionally. One company → many roles falls out naturally:
   intake another role at the same `organization_name` and it reuses the org.
   Forgot the signals at intake, or want to revise after a closer read?
   `set_priority_signals({ job_posting_id, experience_alignment?, career_trajectory?,
   growth_stage? })` — only the fields you pass change.
3. **Capture the Open Brain notes** (the "entries in Open Brain for the company
   and the role"):
   - Once per company: open-brain `capture_thought` — a reference note about the
     company, tags `['job-search', '<Company>']`. The entity-extraction worker
     bridges the company name to the `organizations` row automatically.
   - Per role: `capture_thought` — why this role is interesting / fit notes,
     tags `['job-search', '<Company>']`.
4. **Contacts at the company** (if I mention any): create/find the person, link
   them to the org, tag them for the search:
   - professional-crm `crm_add_contact({ name, title, company: "<Company>",
     tags: ['professional','job-hunt'] })` → `contact_id`
     *(canonical successor: `contact_find_or_create` once the contacts dim MCP
     ships — see the repo plan; it dedups instead of risking a second row.)*
   - organizations `org_link_contact({ contact_id, org_id: organization_id })`

## Play 2 — Submit & track (requirement 4)

- **Apply:** `submit_application({ job_posting_id, referral_contact_id?,
  applied_date })`. Tracking starts automatically — the status-history trigger
  logs the initial state.
- **Move stages (go/no-go is per round):**
  - `update_application_status({ application_id, status })` for the application's
    overall stage (`applied → screening → interviewing → offer → accepted` or
    `rejected`/`withdrawn`). Every transition is auto-logged. In the UI these are
    the **Reject / Withdraw** buttons on each Pipeline kanban card and on the role
    page; a rejected/withdrawn app drops off the board into Pipeline → **"Rejected
    applications"**, which shows the stage it died at, days in that stage, days in
    pipeline, fit score, and interview count (computed from the status history).
  - `schedule_interview({ application_id, interview_type, scheduled_at,
    interviewer_contact_id?, add_to_calendar: true })` — `add_to_calendar` also
    surfaces it in the family-calendar week view.
  - After each round: `log_interview_notes({ interview_id, feedback, rating,
    advance_decision: 'advance' | 'hold' | 'withdraw' | 'rejected',
    decision_notes })`. **`advance_decision` is the explicit "do I move
    forward?" call** the requirements asked for.
- **Close out a filled role:** `close_role({ job_posting_id, reason })` —
  `reason` ∈ `filled` (default) | `expired` | `removed` |
  `no_longer_interested` | `duplicate` | `other`. "Filled" is a property of the *posting*, so
  this works **before or after I apply**: the role drops out of the apply queue,
  follow-ups, and the Dashboard fit map. If I had a live application it cascades to
  the terminal `closed` status (distinct from `rejected`/`withdrawn` — the role
  closed, it wasn't a verdict on me; terminal apps are left alone). Undo with
  `reopen_role({ job_posting_id })`. In the UI: the "Close role…" control on the
  role page (`/posting/:id` or `/role/:id`); closed roles live under Pipeline →
  "Closed roles".

## Play 3 — Weekly review (requirement 3)

1. `get_action_queue()` → four buckets:
   - **roles_to_apply** — tracked postings with no live application, **force-ranked
     by priority score** (see Play 4); each carries `rank`, `priority.score`, and
     the component breakdown. Closing-soon is flagged. Work them top-down.
   - **role_followups** — applications awaiting a response past the threshold.
   - **upcoming_interviews** — scheduled in the next two weeks.
   - **networking** — `job-hunt` contacts gone stale / never contacted.
2. Triage with me; for each new networking action, `capture_thought` a task note
   (tags `['job-search','networking']`) so it persists across sessions.
3. `get_pipeline_overview()` for the status snapshot, `get_funnel_metrics()` for
   the funnel metrics when I ask "how's it going?". It returns four per-stage
   metrics (each defined in `semantic/metrics/`): `conversion_rates` and
   `median_days_from_applied` (cumulative), plus `pass_through` — the
   decision-conditioned advance rate (advanced ÷ decided, pending kept aside) —
   and `median_days_in_stage` (dwell within a stage). The tracking-hub
   **Dashboard** surfaces the latter two as the "Stage funnel" table and the
   status distribution; click a status bar there to list the apps in that phase.

## Play 4 — Prioritize the apply queue (force-ranking)

The order I work applications is not gut feel — it's a 0–100 **priority score**
computed by `compute_priority()` and surfaced ranked in `roles_to_apply` and via
`get_prioritized_roles({ limit? })`. The canonical definition lives in the
**semantic layer**: [`semantic/metrics/priority_score.yaml`](semantic/metrics/priority_score.yaml).

Five weighted components (weights sum to 1.0):

| Component | Weight | Source | What I judge |
|---|---|---|---|
| experience | 0.35 | `experience_alignment` (you set, 0..1) | fit of the JD vs my resume |
| location | 0.15 | `location` + `remote_policy` (derived) | hybrid-NYC > remote > onsite-NYC > hybrid-other > onsite-other |
| comp | 0.15 | `salary_min/max` (derived) | midpoint normalized into a band |
| career | 0.20 | `career_trajectory` (you set) | step_up > lateral > step_back |
| growth | 0.15 | `growth_stage` (you set) | growth/early > late/seed > public |

- **Your job is the three subjective signals** (`experience_alignment`,
  `career_trajectory`, `growth_stage`). Location and comp are scored
  deterministically from columns intake already captured — don't double-enter them.
- Set the signals at intake (Play 1) or later with `set_priority_signals`.
- Un-scored signals fall back to neutral (0.5), so a role is never *buried* just
  for being un-enriched — but enrich it so the ranking is real.
- **All three subjective signals also have AI judges in the tracking-hub UI**, so
  they don't have to be hand-set. On a role page (`/posting/:id` or `/role/:id`)
  the **Priority breakdown** card at the top shows every input expanded (raw value
  · weight · points), with a button per judged signal:
  - **experience** → "Run AI judge" (judge-fit): scores every resume variant vs
    the JD and lifts `experience_alignment` to the best fit. It scores by
    **adjacency, not keyword matching** — each JD requirement is tiered Identical
    / Adjacent / Aware / Gap (so a Looker résumé still earns credit against a
    Tableau JD, but a real gap stays a gap), and the score is the importance-
    weighted average of that per-requirement table. The table is persisted and
    shown on the role page; the tiering rules are in
    [`resume-scoring-prompt-instructions.md`](resume-scoring-prompt-instructions.md).
  - **career** → "Judge career move" (judge-career): reads the JD against the
    user's **career profile** (Resumes page → Career profile) and returns
    step_up/lateral/step_back. Without a profile set the call is un-personalized
    (it warns), so fill the profile in first.
  - **growth** → "Judge company growth" (judge-growth): web-searches the company's
    funding/headcount/momentum, classifies the stage **once per company**, and
    caches the signals on the `organizations` row (so other roles at that company
    are scored for free). Costs an external search — the per-company caching is why.
  Each judge writes the same column `compute_priority` reads, so a freshly judged
  role re-ranks immediately. See [`supabase/functions/JUDGE_SIGNALS_SPEC.md`](supabase/functions/JUDGE_SIGNALS_SPEC.md).
- To re-weight the search (e.g. care more about comp) **for this user**, move the
  sliders on the **Pipeline page** — they persist to the `priority_weights` table
  and `resolve_priority_weights()` feeds them into the force-ranking, so the queue
  (UI *and* MCP/`get_action_queue`) re-ranks immediately. To move the **default**
  everyone falls back to, edit the YAML **and** the matching `DEFAULT`s in
  `functions.sql` (`compute_priority` / `get_prioritized_roles` / the literal in
  `resolve_priority_weights`), then re-apply `functions.sql`. The YAML is the
  source of truth for the defaults.

## Notes for the assistant

- Prefer `intake_role` over manually calling `org_find_or_create` then a posting
  insert — it's one transaction and can't half-fail.
- Don't invent a second `organizations` or `contacts` row for an entity that
  already exists; search first (`org_search`, `crm_search_contacts`) or use the
  find-or-create paths.
- Never put secrets, the Supabase project ref, or real personal contact details
  into committed files — this repo is public. Real data lives only in the
  database; these plays describe *how* to write it, not *what* the data is.
