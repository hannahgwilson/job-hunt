# Spec — automating the two remaining agent-judged priority signals

`priority_score` has three subjective, agent-judged inputs (see
[`semantic/metrics/priority_score.yaml`](../../semantic/metrics/priority_score.yaml)).
One is already automated; two are still entered by hand:

| Signal | Column | Weight | Automated? |
|---|---|---|---|
| experience | `experience_alignment` (0..1) | 0.35 | ✅ `judge-fit` edge function |
| **career** | `career_trajectory` (enum) | 0.20 | ❌ manual via `set_priority_signals` |
| **growth** | `growth_stage` (enum) | 0.15 | ❌ manual via `set_priority_signals` |

Goal: two new edge functions, `judge-career` and `judge-growth`, that mirror the
`judge-fit` pattern — read context, make one server-side Anthropic call with a
forced structured-output tool, persist via an RPC that lifts the column, return
the fresh value so the page re-renders. They surface in the role pages next to
"Run AI judge", and can be batched like `judge-fit`.

The hard part isn't the plumbing (that's copy-`judge-fit`) — it's **what context
each judge needs to produce a non-garbage answer.** That's the focus below.

---

## 1. `judge-career` → `career_trajectory` (step_up | lateral | step_back)

"Lateral or growth, growth weighted higher" — the enum already encodes it
(`step_up` 1.0 > `lateral` 0.75 > `step_back` 0.25). The judge picks the bucket
**and** a rationale.

### Why this needs more than the JD

`career_trajectory` is **relative and personal**. The same Staff Eng role is a
step_up for a Senior, lateral for a Staff, step_back for a Director. And
"forward" depends on what *this user* is optimizing for — an IC who wants to stay
IC should read a people-management role as **lateral/step_back, not step_up**,
even though it's "more senior" on paper. A judge that only sees the JD will guess
seniority from the title and miss the user's intent entirely.

So the judge needs a **baseline + an ambition vector**.

### Information needed

**A. Candidate baseline** — where they are now. Today this is only implicit in
the resume. Recommend a small explicit profile so the judge isn't re-deriving it
(and guessing) on every call:

- current title + level (e.g. "Senior", "Staff", "Director")
- track: IC vs manager, and current span (team size managed, if any)
- years of experience / years at level
- current comp band (for the comp delta — optional, sensitive)
- primary domain / function (e.g. "backend infra", "ML platform")

**B. Ambition vector** — what "forward" means *to them*. This is the piece that
makes the call meaningful rather than mechanical:

- target track (stay IC / move to management / open)
- target level / title they're reaching for
- what counts as a step up for them: more scope? more comp? bigger company tier?
  more autonomy / earlier-stage? a domain pivot they want?
- domains they'd treat as a **lateral pivot** (sideways, fine) vs ones that are
  off-track (step_back)

**C. Target role signals** — from the JD we already store:

- title + inferred level, IC-vs-manager, scope/span language
- comp band (`salary_min/max`) vs current
- company tier/stage (cross-reference `growth_stage` once #2 exists)
- domain adjacency vs the user's

### Decision the judge makes

Compare B→C across these axes — **seniority delta, scope delta, comp delta,
track change, domain fit** — weigh them by the ambition vector, and emit:

```
{ trajectory: "step_up" | "lateral" | "step_back",
  confidence: 0..1,
  deltas: { seniority, scope, comp, track, domain },   // each: up | flat | down | n/a
  rationale: "2-3 sentences, specific to this role vs their current seat" }
```

Map `trajectory` straight onto the column. Keep `deltas`/`rationale` for display
(same way `judge-fit` shows spikes/gaps), so the user sees *why* it's a lateral.

### New storage needed

- **`career_profile`** (one row per user): the baseline (A) + ambition (B) above.
  Set once on a Profile/Settings page, editable. Without it, `judge-career` falls
  back to inferring the baseline from the resume and assumes "more senior =
  step_up" — usable but blunt; flag in the UI that it's un-personalized.
- Reuse `set_priority_signals` to write `career_trajectory`; optionally a
  `save_career_judgment` RPC to also persist `deltas`/`rationale` for display.

---

## 2. `judge-growth` → `growth_stage` (seed | early | growth | late | public | unknown)

"Growth potential" — how much upside the *company* has. Unlike career, this is
**not personal**; it's a factual read of the company's stage and momentum. The
problem is the facts **aren't in our data** — `organizations` has only
`name, industry, description, website_url, culture_url, tags` (migration 005);
nothing about funding, headcount, or traction. The JD almost never states stage.

So the judge needs **external company signals**, fetched at judge time.

### Information needed (the signals that actually predict upside)

- **Funding stage + last round**: seed / A / B / C / D+ / late / public, and
  *when* — a Series B from 2019 with no follow-on is a very different story than a
  2025 Series B.
- **Total raised + last known valuation.**
- **Headcount + headcount trend** (growing fast / flat / recent layoffs) — the
  single best public proxy for traction.
- **Revenue / ARR + growth rate**, if discoverable.
- **Momentum signals**: recent funding, marquee customers, product launches,
  notable hires — and negatives: down rounds, layoffs, leadership churn.
- **Company age** and **sector / TAM** (big expanding market vs niche).
- If **public**: ticker, market cap, recent price/revenue trajectory → maps to
  `public` (stable, less upside) unless hyper-growth.

### Where the signals come from — the one real decision

Three options; recommend **(c)**:

- **(a) Manual / agent-supplied at intake.** Cheapest, but it's exactly the
  hand-entry we're trying to remove, and goes stale.
- **(b) Judge only from stored org fields + JD.** No external calls, but with
  today's columns that's almost no signal → mostly `unknown`. Not meaningful.
- **(c) Web-search-backed judge (recommended).** Give the Anthropic call the
  server-side `web_search` tool; prompt it to look up funding/headcount/momentum
  for `organization.name` (+ `website_url` to disambiguate), then classify. This
  is what makes the answer real without manual entry. Costs more per call and is
  non-deterministic, so:
  - **cache** the fetched signals back onto `organizations` (new additive cols:
    `funding_stage`, `last_round`, `last_round_date`, `total_raised`,
    `headcount`, `headcount_as_of`, `growth_signals jsonb`, `signals_fetched_at`)
    so re-judging other roles at the same company is cheap and the company page
    can show them;
  - judge **per company, not per posting** (growth is a company property) — one
    fetch updates `growth_stage` on all that org's open postings.

### Decision the judge makes

```
{ stage: "seed"|"early"|"growth"|"late"|"public"|"unknown",
  confidence: 0..1,
  signals: { funding_stage, last_round_date, headcount, headcount_trend,
             total_raised, momentum: [..], risks: [..] },
  sources: [urls],                       // so the read is auditable
  rationale: "2-3 sentences" }
```

`stage` → `growth_stage` column; cache `signals`/`sources` on `organizations`;
keep `rationale` for display. `unknown` when web search comes back thin — don't
invent a stage.

---

## Shared implementation notes (both functions)

- **Copy `judge-fit`'s skeleton**: CORS, JWT→user_id, service-role client scoped
  to `user_id`, posting/org ownership check, forced `tool_choice`, persist-RPC,
  return fresh value. Secrets `ANTHROPIC_API_KEY` / `JUDGE_MODEL` already exist;
  remember to ship `deno.json` alongside `index.ts`.
- **UI**: add "Judge career" / "Judge growth" buttons to the role page (next to
  "Run AI judge"); on success the `PriorityBreakdown` at the top re-renders with
  the new component no longer at its neutral 0.5 default.
- **Batch**: mirror the `judge-fit` backfill path so all un-judged roles (career)
  / all employer-target orgs (growth) can be scored in one sweep.
- **Cost/quality**: career is cheap (no web search); growth uses web search →
  cache aggressively and judge per-company to avoid re-paying per posting.
