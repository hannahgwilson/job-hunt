# Resume Scoring Prompt — Tuning Instructions

These instructions are for an agent iterating on the ATS/judge-fit scoring prompt.
The goal is a prompt that produces scores that are honest, defensible in an interview,
and reward genuine transferable skills without inflating real gaps.

---

## The core problem to fix

Default scoring prompts do literal keyword matching. A candidate with "Looker" gets
zero credit when the JD says "Tableau." This produces misleading scores for skilled
people with adjacent stacks. The fix is a structured adjacency judgment layer — but
it must not over-extend: a real skill gap should remain a gap.

---

## Scoring framework the prompt must implement

For each technical requirement in the JD, the judge must classify the candidate's
matching evidence into one of four tiers:

| Tier | Definition | Score weight |
|---|---|---|
| **Identical** | Same tool / skill named explicitly on the resume | 1.0 |
| **Adjacent** | Different tool, same category and paradigm; candidate could demonstrate the skill in an interview | 0.75 |
| **Aware** | Candidate has worked alongside teams using the tool, or has conceptual knowledge, but has not operated it themselves | 0.2 |
| **Gap** | No meaningful exposure; candidate would need to learn from scratch | 0.0 |

The final experience_alignment score (0–1) is the weighted average across all JD
requirements, where requirements can carry different weights (e.g., a "required" skill
outweighs a "nice-to-have").

---

## Adjacency judgment rules (apply these in order)

These are principles, not a lookup table. The agent must reason from these rules to
new tools it encounters, not match against a hardcoded list. It should also be extensible to other technical job types, like data science, data engineering, analytics engineering or software engineering. 

**Rule 1 — Same job-to-be-done, same data paradigm = Adjacent**
If two tools solve the same analytical problem in the same way (e.g., both are
code-first BI tools, or both are columnar cloud data warehouses), they are Adjacent.
The candidate must be able to articulate the paradigm clearly in an interview, not
just name-drop the JD's tool.

**Rule 2 — Same category, different paradigm = Aware at best**
If two tools are in the same broad category but operate on fundamentally different
models (e.g., a drag-and-drop BI tool vs. a semantic-layer BI tool), do not grant
Adjacent. The skill transfer is real but incomplete; score as Aware unless the resume
shows concrete evidence of bridging the gap.

**Rule 3 — Cloud platform portability is real but bounded**
Hands-on experience with one major cloud platform (GCP, AWS, Azure) gives meaningful
Adjacent credit for core compute, storage, and orchestration services on another
platform. It does NOT give Adjacent credit for platform-specific managed services with
no clear equivalent (e.g., a proprietary ML pipeline service that has no direct analog).

**Rule 4 — Managed vs. open-source variants of the same tool = Adjacent**
If the JD specifies one variant (e.g., cloud-managed) and the candidate has the other
(e.g., open-source), treat as Adjacent. The engineering patterns are the same; the
operational difference is shallow.

**Rule 5 — Orchestration and workflow tools require hands-on evidence**
"Worked with teams that use X" or "aware of X" is Aware, not Adjacent. The candidate
must have personally written or scheduled jobs in the tool to qualify as Adjacent.
This distinction matters because orchestration is operationally complex — interviewers
will probe it.

**Rule 6 — ML/AI-adjacent ≠ MLOps**
Exposure to ML outputs (consuming model scores, working with DS teams, using AI
tooling) does not count as MLOps expertise. MLOps (model serving, experiment tracking,
feature stores, pipeline management) requires direct hands-on work to score above Aware.
Do not grant Adjacent for this domain unless the resume shows the candidate built or
owned ML infrastructure. - This rule is an example of something that is NOT adjacent. do not tune specifically to ML ops as a discipline. 

**Rule 7 — "Familiar with" language on a resume = Aware**
If the candidate signals their own uncertainty ("exposure to," "familiar with,"
"knowledge of"), honor that self-assessment. Do not upgrade it to Adjacent.

---

## Test harness — three-resume iteration

Run the following procedure for each scoring prompt iteration:

### Setup
Prepare three resume variants against a single target JD:
1. **Base resume** — your general resume, minimally tailored
2. **IC-optimized** — emphasizes technical depth and individual contributions
3. **Manager-optimized** — emphasizes people leadership, team building, roadmap ownership

For each pair of (resume, JD), run the scoring prompt and collect:
- Overall score (0–1)
- Per-requirement tier classification (Identical / Adjacent / Aware / Gap)
- Brief rationale for each classification

### What good output looks like
- The manager-optimized resume should score higher on management requirements
- The IC-optimized resume should score higher on hands-on technical requirements
- Both should score similarly on requirements where the candidate has genuine coverage
- Real gaps (per Rule 6, Rule 5, etc.) should show as Gap on ALL three resumes —
  they don't disappear just because a resume is well-written

### Red flags in scoring output — prompt needs tuning if you see these
- A Gap becomes Adjacent across resume variants purely due to word choice (not
  added evidence)
- Adjacent scores appear for tools that are in fundamentally different paradigms
  (Rule 2 violation)
- The IC resume and Manager resume score identically on management requirements
  (prompt isn't differentiating)
- MLOps requirements score as Adjacent when the resume only mentions ML consumption
  or AI tooling (Rule 6 violation)

### Tuning loop
1. Run all three resumes → collect scores + rationale
2. Identify the highest-scoring resume and inspect its Gap classifications —
   are any Gaps that should stay Gaps being upgraded?
3. Tighten the prompt for those specific rules; re-run
4. Check that tightening didn't accidentally penalize legitimate Adjacent matches
5. Repeat until all three resumes score plausibly relative to each other AND
   Gaps are stable across variants

---

## Notes on prompt structure

The scoring prompt should:
- Present the JD requirements as a structured list before asking for scoring
- Explicitly instruct the model to apply the four-tier framework and cite the
  relevant rule for each Adjacent or Aware classification
- Ask for a per-requirement table before computing the final score (chain-of-thought
  reduces hallucinated scores)
- Explicitly instruct the model NOT to infer skills from job titles alone —
  evidence must appear in the resume body

The scoring prompt should NOT:
- Hard-code specific tool equivalencies (use the rules, not a lookup table)
- Ask for a single score without intermediate reasoning
- Allow the model to average across requirements without weighting required vs.
  nice-to-have skills
