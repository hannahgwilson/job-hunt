# Semantic layer

A lightweight, YAML-defined catalog of the **metrics** this job search runs on.
Each file is a *spec*: what the metric means, its grain, the inputs it reads, and
— crucially — the **SQL function that implements it**. The YAML is the contract;
`functions.sql` is the executable. They are kept in sync by hand and the YAML
links to the function so a reader can jump straight from definition to code.

Why bother for a personal job search? Two reasons:

1. **One definition, two consumers.** The metrics are computed in Postgres
   functions (`functions.sql`) that *both* the MCP agent and the React tracking
   hub call. The YAML is the single human-readable place that says what
   "conversion rate" or "priority score" actually mean, so the agent, the UI,
   and I never argue about it.
2. **It's the architecture I'd build at work, in miniature.** A real semantic
   layer (dbt metrics, Cube, LookML) decouples *metric definition* from *every
   surface that reads it*. This is that idea, scoped to a repo you can read in
   five minutes.

## Catalog

| Metric | File | Implemented by |
|---|---|---|
| Time in stage | [`metrics/time_in_stage.yaml`](metrics/time_in_stage.yaml) | `get_funnel_metrics()` → `median_days_from_applied` |
| Days in stage (dwell) | [`metrics/days_in_stage.yaml`](metrics/days_in_stage.yaml) | `get_funnel_metrics()` → `median_days_in_stage` |
| Conversion rate | [`metrics/conversion_rate.yaml`](metrics/conversion_rate.yaml) | `get_funnel_metrics()` → `conversion_rates` |
| Pass-through rate | [`metrics/pass_through_rate.yaml`](metrics/pass_through_rate.yaml) | `get_funnel_metrics()` → `pass_through` |
| Priority score | [`metrics/priority_score.yaml`](metrics/priority_score.yaml) | `compute_priority()`, surfaced by `get_prioritized_roles()` / `get_action_queue()` |

The funnel pairs are easy to confuse, so they're defined as distinct metrics:
**conversion_rate** divides by everyone who *ever reached* a stage (pending
included; it drifts), while **pass_through_rate** divides only by *decided*
applications (pending kept aside). **time_in_stage** is *cumulative* days from
`applied`; **days_in_stage** is the *dwell* within one stage. All four come from
`get_funnel_metrics()`.

## Conventions

- `grain` — the row the metric is defined over (one application, one stage
  transition, one posting).
- `source` — the base tables / columns it reads.
- `implemented_by` — the SQL function in `functions.sql` that returns it. **If you
  change a weight or a rule here, change it there too** (the priority weights are
  duplicated as function defaults so the function is runnable on its own).
- `dimensions` — what you can slice the metric by.

## A note on the priority weights

`priority_score` is the only metric with tunable knobs. Its weights and the
comp-normalization band live here as the canonical values **and** as default
parameters on `compute_priority(...)`, so the function runs standalone while this
file stays the source of truth. To re-weight the search (e.g. care more about
comp), edit `metrics/priority_score.yaml`, then update the matching `DEFAULT`s in
`functions.sql`. No personal data lives in any of these files — only definitions.
