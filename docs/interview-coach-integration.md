# Interview coach — folding the coaching skill into the prep flow

Status: **shipped** · Owner: Hannah · 2026-08-10

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
| `coaching_artifacts` | 1 per (user, kind, scope) | the per-command outputs that had no home |

`coaching_stories` is the important one. `get_story_cheat_sheet` already rolls
stories up *derived* from `interview_prep_sessions.synthesis` — read-only, thrown
away and regenerated each time. The storybank is durable: stories carry a
strength score, an earned secret, a last-used timestamp, and survive the session
that produced them.

> **Revised by migration 026.** The two were allowed to coexist — "the cheat
> sheet is a per-employer view, the storybank is the candidate's actual
> inventory" — and in practice that meant the UI's Story library rendered the
> cheat sheet while the inventory stayed empty. The storybank is now the library.
> `coaching_stories` also gained `aliases`, `company`, `sharpen`, and
> `is_anchor`; see `consolidate_stories` below for why each is needed.

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

Three scopes, not two (revised by migration 026):

| Scope | Stages | Keyed on |
|---|---|---|
| per-round | `concerns`, `questions`, `hype` | `interview_id` |
| **per-role** | `decode` | `job_posting_id` |
| per-candidate | `progress`, `consolidate_stories`, `consolidate_cluster` | neither |

Where each one is reachable today:

| Stage | Surface |
|---|---|
| `concerns`, `questions`, `hype` | Interview Prep page, below the round flow (`CoachSheets.tsx`) |
| `decode` | Role page — both `/posting/:id` and `/role/:id` — and read-only at the top of each round's prep page |
| `progress` | Resumes page, in the storybank panel |
| `consolidate_stories`, `consolidate_cluster` | Interviews → Story library (`StoryLibrary.tsx`) |

### Why `decode` moved off the round

It shipped per-round and that was wrong in a way that only showed up with real
data: a nine-round Anaconda loop meant nine `decode` artifacts, nine identical
model calls against the same job description, and nine manual JD pastes — because
the JD text wasn't persisted either, so every regenerate asked for it again.

A job description is a property of the **posting**. So:

- `coaching_artifacts` grew a `job_posting_id` scope, with a CHECK that a row
  carries exactly one scope and a COALESCE-over-both unique index. Existing
  per-round decodes were re-pointed at their posting, newest-wins.
- `job_postings.jd_text` keeps the posting body. `intake-from-url` already
  fetched the page and threw the text away; it now returns it, `intake_role`
  stores it, and `get_decode_context` reads it. A generated `has_jd_text` flag
  lets the UI decide whether it needs a paste box without pulling tens of KB down.
- Decode runs **once, at intake**, fire-and-forget beside the fit judge. The
  paste box only appears for walled pages (LinkedIn, most ATSes) where the fetch
  failed, and a pasted JD is stored so it's asked for exactly once.
- The stage no longer routes through `get_interview_prep_session`, so it doesn't
  need a round on the calendar or a started prep session. That matters: decode
  tells you which competencies to go build stories for, which is upstream of
  scheduling anything.

### `consolidate_stories` → `consolidate_cluster`

The one flow that **proposes rather than persists**. Every other stage writes
directly, because a bad artifact is just regenerated — but consolidation merges
stories, and if four tellings exist and only one carried the dollar figure, the
wrong merge loses that number permanently. It returns clusters; the client
applies what's accepted through `upsert_story` / `merge_stories`.

**It is two calls, and that's load-bearing.** It shipped as one — every telling
from every prep synthesis in a single prompt, `max_tokens: 8000`, asked to both
cluster *and* write each assembled STAR. That is output-bound, and it scales with
the volume of material rather than the number of stories, so it worked in testing
and then stopped returning entirely: at ~40 syntheses the gateway killed it at
150,105 ms against the 150 s Edge Function ceiling, and supabase-js could only
report the 504 as "Edge Function returned a non-2xx status code". So:

- `consolidate_stories` (**plan**) reads a one-line index of every telling —
  title, employer, competency, clipped situation — and emits identity only:
  `title`, `variant_titles`, `matches_anchor`. Output scales with the number of
  distinct stories, which is bounded by how many stories a person has.
- `consolidate_cluster` (**assemble**) writes one story from the full text of
  just its own tellings, found by matching `variant_titles` — which is why the
  plan tool insists on copying those character for character. One request per
  story, three in flight, each card filling in as it lands.

Each story also gets the model's whole attention instead of a share of one 8k
budget, and a failed assembly is scoped to its own card with a retry.
Both passes check `stop_reason` now: a forced tool call that runs out of output
budget still returns a `tool_use` block, just with the tail of the story missing.

It also fixes the reason the storybank was empty in practice: prep synthesis has
written to it since this integration shipped, but every session that ran *before*
that lived only in `interview_prep_sessions.synthesis`, under a title that
session invented. Consolidation is the backfill, and `aliases` + anchors are what
stop the drift recurring — see **Play 5** in [`CLAUDE.md`](../CLAUDE.md).

The candidate layer itself is fully MCP-exposed (profile, storybank, scores,
question bank, and `get_coaching_context` as the one-call read) — see **Play 5**
in [`CLAUDE.md`](../CLAUDE.md).

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
