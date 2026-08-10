# Interview coach — folding the coaching skill into the prep flow

Status: **design + build** · Owner: Hannah · 2026-08-10

Integrates [`interview-coach-skill`](https://github.com/noamseg/interview-coach-skill)
(a Claude Code skill: `SKILL.md` + ~675KB of `references/`) into this app's
interview prep. The skill stays the source of truth; the app vendors a compiled
subset of its references and grows a **coaching layer** in Postgres so both
surfaces — dashboard and MCP — read the same state.

## The problem in one line

`coaching_state.md` and `interview_prep_sessions` are the same kind of object at
different scopes — **per-search** vs **per-round** — and the app only has the
second one.

Today every prep session starts from zero. You can rehearse eight rounds and the
ninth knows nothing about the previous eight: no storybank, no score trend, no
record of which questions actually got asked, no sense of whether your answers
are getting better. The skill is built entirely around that continuity. Porting
it means giving the app a candidate-scoped layer for the per-round flow to read
from and write back to.

## Two scopes

| Scope | Lives in | Lifetime | Contents |
|---|---|---|---|
| **Candidate** (new) | `coaching_*` tables | the whole search | profile, storybank, score history, question bank, generated sheets |
| **Round** (exists) | `interview_prep_sessions` | one interview | intake → research → transcript → synthesis |

The round-scoped flow is unchanged in shape. What changes is that each stage now
**reads** the candidate layer into its prompt and **writes** its results back.

## Rubric change

The skill's rubric replaces STAR-only scoring. STAR doesn't disappear — it stays
the *structural* frame inside `Structure` — but four more dimensions come with it:

| Dimension | What it catches that STAR doesn't |
|---|---|
| Substance | evidence quality and depth |
| Structure | narrative clarity (this is where STAR lives) |
| Relevance | did you answer the question actually asked |
| Credibility | is this believable, is the proof real |
| **Differentiation** | could any qualified candidate have given this answer |

Scored 1–5, calibrated against the profile's seniority band. Differentiation is
the one the app has no equivalent for at all, and it's the skill's whole thesis:
a technically complete STAR answer that anyone could have given still loses.

## Schema — migration 024

Five tables, all RLS-isolated to `auth.uid()`, same boilerplate as
`interview_prep_sessions`.

| Table | Rows | Replaces (in `coaching_state.md`) |
|---|---|---|
| `coaching_profiles` | 1 per user | Profile, Resume Analysis, Active Coaching Strategy, Drill Progression, Coaching Notes, Meta-Check Log |
| `coaching_stories` | many | Storybank + Story Details |
| `coaching_scores` | many | Score History (5-dim, plus self-score for the calibration engine) |
| `coaching_questions` | many | Interview Intelligence → Question Bank |
| `coaching_artifacts` | 1 per (user, kind, interview) | the per-command outputs that had no home |

`coaching_stories` is the important one. `get_story_cheat_sheet` already rolls
stories up *derived* from `interview_prep_sessions.synthesis` — read-only, thrown
away and regenerated each time. The storybank is durable: stories carry a
strength score, an earned secret, a last-used timestamp, and survive the session
that produced them.

## Stages

Existing stages, upgraded:

| Stage | Change |
|---|---|
| `research` | prompt now carries the profile (target role, seniority, transition) |
| `chat` reply | interviewer draws on the question bank — asks what this company actually asked, and probes competencies with no strong story |
| `chat` feedback | 5-dimension rubric, seniority-calibrated, self-reflection first; writes a `coaching_scores` row |
| `synthesize` | reconciles stories against the storybank instead of inventing fresh ones; writes back |

New stages, ported from skill commands:

| Stage | Skill command | Produces |
|---|---|---|
| `concerns` | `concerns` | likely interviewer objections + counters, from resume analysis and fit gaps |
| `questions` | `questions` | questions to ask, tailored to who's actually in the room |
| `hype` | `hype` | pre-interview 3×3 and a pre-mortem — the thing you read in the parking lot |
| `progress` | `progress` | trend review across rounds: dimension trajectory, calibration gap, bottleneck |
| `decode` | `decode` | JD → competency extraction and coverage against the storybank |

`progress` is candidate-scoped (no `interview_id`); the rest are per-round.

## Reference bundling

`dev/build_coach_bundle.mjs` reads the skill repo (`COACH_SKILL_DIR`, defaults to
`../interview-coach-skill`) and compiles **section-level slices** into
`supabase/functions/interview-prep/coach-bundle.ts`, which is committed.

Whole files are not an option — `references/` is 675KB and a single command file
runs to 42KB. The manifest names a heading inside a file; the compiler extracts
that heading's section only. Each stage composes a handful of fragments and stays
under a few KB of coaching guidance.

The generated module carries a `SOURCE_DIGEST` of the inputs, so drift between
this repo and the skill repo is detectable rather than silent.

## Deliberately out of scope

The skill has 24 commands. These are not ported, and the reasons differ:

- **`resume`, `linkedin`, `decode`'s résumé half, `pitch`** — the app already owns
  these surfaces (bullet library, `judge-fit`, `assemble-resume`, résumé variants).
  A second opinionated implementation would drift from the first.
- **`salary`, `negotiate`, `apply`, `thankyou`, `outreach`, `present`, `reflect`** —
  real value, but outside interview prep. They belong to the pipeline and offer
  stages, not the prep page. Revisit as their own feature.
- **`practice` / `mock` as separate modes** — the app's mock chat already covers
  this; the drill *ladder* (progression stages) folds into the profile's
  `drill_stage` rather than becoming its own surface.

The skill remains independently usable as a Claude Code skill against a
`coaching_state.md` file. This integration does not read that file — the app's
Postgres layer is its own store, and the MCP tools are how conversation reaches it.
