# Metrics — a lightweight semantic layer

These YAML files are the **single source of truth for what each metric *means***,
kept separate from *how it's computed*. The "how" lives in `functions.sql` as
Postgres functions; the "what" lives here as declarative definitions. It's the
same split a real semantic layer (dbt MetricFlow, Cube, LookML) makes:

```
logical:   metrics/*.yml          ← name, grain, unit, dimensions, owner   (this dir)
physical:  functions.sql          ← the SQL that returns the numbers
surface:   web/ + job-hunt-mcp    ← call the SQL, render the result
```

Why bother for a personal job tracker? Two reasons:

1. **One definition, many consumers.** The dashboard, the MCP agent, and any
   future notebook should all agree on what "conversion rate" means. Writing it
   once, declaratively, prevents three subtly different versions.
2. **It documents the model.** Each metric names its grain, its source table,
   the function that implements it, and the JSON key it surfaces as — so the
   path from a number on screen back to a row in the database is explicit.

## Files

| File | Metric | Implemented by |
|---|---|---|
| [`_semantic_model.yml`](_semantic_model.yml) | Shared entities, dimensions, and the stage ladder every metric references | — |
| [`time_in_stage.yml`](time_in_stage.yml) | Median days from `applied` to reaching each later stage | `get_funnel_metrics()` |
| [`conversion_rate.yml`](conversion_rate.yml) | Share of applications that advance from one stage to the next | `get_funnel_metrics()` |
| [`prioritization_score.yml`](prioritization_score.yml) | Force-rank of postings into apply order — **definition only; algo built in a separate worktree** | _(planned)_ |

## Conventions

- **`grain`** — the unique key of one row of the metric. `time_in_stage` is
  per-stage; `conversion_rate` is per stage-transition.
- **`source`** — the table the metric is derived from, plus `implemented_by`
  (the SQL function) and `surfaced_as` (the JSON key it appears under in that
  function's return value). Follow those three and you can trace any number end
  to end.
- **`status: implemented | planned`** — `planned` metrics are designed here but
  not yet wired to SQL. `prioritization_score` is the only one, by design.
