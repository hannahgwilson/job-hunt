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
| `thoughts` (Open Brain) | `job-search`, plus the company name | notes about a company or role |

## Play 1 — Intake a role (requirements 1 & 2)

When I paste a job-description link (or describe a role):

1. **Enrich.** Read the posting at the URL and extract: title, salary range,
   key requirements, location, remote policy, source. If the page is walled,
   ask me for the fields instead.
2. **Persist in one call** — job-hunt `intake_role`:
   ```
   intake_role({
     organization_name: "Anthropic",     // found case-insensitively or created
     title: "Senior AI Engineer",
     url: "<the link>",
     salary_min, salary_max, requirements: [...],
     location, remote_policy, source: "linkedin"
   })  →  { organization_id, posting_id }
   ```
   This find-or-creates the org (tagged `employer-target`) and inserts the
   posting transactionally. One company → many roles falls out naturally:
   intake another role at the same `organization_name` and it reuses the org.
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
    `rejected`/`withdrawn`). Every transition is auto-logged.
  - `schedule_interview({ application_id, interview_type, scheduled_at,
    interviewer_contact_id?, add_to_calendar: true })` — `add_to_calendar` also
    surfaces it in the family-calendar week view.
  - After each round: `log_interview_notes({ interview_id, feedback, rating,
    advance_decision: 'advance' | 'hold' | 'withdraw' | 'rejected',
    decision_notes })`. **`advance_decision` is the explicit "do I move
    forward?" call** the requirements asked for.

## Play 3 — Weekly review (requirement 3)

1. `get_action_queue()` → four buckets:
   - **roles_to_apply** — tracked postings with no live application (closing-soon
     flagged).
   - **role_followups** — applications awaiting a response past the threshold.
   - **upcoming_interviews** — scheduled in the next two weeks.
   - **networking** — `job-hunt` contacts gone stale / never contacted.
2. Triage with me; for each new networking action, `capture_thought` a task note
   (tags `['job-search','networking']`) so it persists across sessions.
3. `get_pipeline_overview()` for the status snapshot, `get_funnel_metrics()` for
   conversion + median time-in-stage when I ask "how's it going?".

## Notes for the assistant

- Prefer `intake_role` over manually calling `org_find_or_create` then a posting
  insert — it's one transaction and can't half-fail.
- Don't invent a second `organizations` or `contacts` row for an entity that
  already exists; search first (`org_search`, `crm_search_contacts`) or use the
  find-or-create paths.
- Never put secrets, the Supabase project ref, or real personal contact details
  into committed files — this repo is public. Real data lives only in the
  database; these plays describe *how* to write it, not *what* the data is.
