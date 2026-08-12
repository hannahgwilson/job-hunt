-- Migration 026: de-bloat the coaching layer.
--
-- Three changes, each fixing a place where the shape of the data didn't match
-- the shape of the work:
--
--   A. `decode` was scoped to an interview ROUND. But a job description is a
--      property of the POSTING — decoding it nine times for Anaconda's nine
--      rounds is nine identical model calls and nine manual JD pastes. It moves
--      to the posting, runs once at intake, and the JD text it read is kept so
--      a re-run doesn't need the paste box.
--
--   B. There were two story libraries: this table (durable, and empty) and
--      get_story_cheat_sheet's rollup over interview_prep_sessions.synthesis
--      (derived, and where everything actually was). The derived one re-invents
--      a title per session, so the same Garner steerage story exists under four
--      names and none of them accumulate. The storybank becomes the one
--      library; the columns added here are what consolidation needs to fold
--      those variants into one best-of story without losing the trail.
--
--   C. One column, for outcome reconciliation. The read itself
--      (get_outcome_reconciliation) works off columns that already exist, but
--      "I looked at this and the record is right" needs somewhere to live —
--      see below.
--
-- After applying, (re)apply functions.sql.

-- ============================================================================
-- A. decode moves from the round to the posting
-- ============================================================================

-- The posting body decode read. Populated by intake-from-url at intake (the
-- edge function already fetches the page; it just used to throw the text away)
-- or pasted by hand on the role page. Without this, a saved decode couldn't be
-- regenerated without the user finding the JD again — which is exactly the
-- awkward empty-textarea state the prep page shipped with.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS jd_text TEXT;

-- Generated flag so the UI can ask "is there a JD stored?" without pulling the
-- body down. jd_text runs to tens of KB and every role-page load would otherwise
-- carry it just to decide whether to render a paste box.
ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS has_jd_text BOOLEAN
    GENERATED ALWAYS AS (jd_text IS NOT NULL) STORED;

-- coaching_artifacts grows a second scope. Three scopes now coexist:
--   interview_id set          → per-round  (concerns, questions_to_ask, hype)
--   job_posting_id set        → per-role   (decode)
--   both NULL                 → per-candidate (progress)
ALTER TABLE coaching_artifacts
    ADD COLUMN IF NOT EXISTS job_posting_id UUID REFERENCES job_postings(id) ON DELETE CASCADE;

-- Collapse existing per-round decodes down to one per posting BEFORE the new
-- unique index goes on, or the index build fails on the duplicates. Newest
-- wins: a later decode was run against the same JD with a fuller storybank.
WITH mapped AS (
    SELECT a.id,
           a.user_id,
           a.generated_at,
           jp.id AS posting_id,
           row_number() OVER (
               PARTITION BY a.user_id, jp.id ORDER BY a.generated_at DESC
           ) AS rn
    FROM coaching_artifacts a
    JOIN interviews i    ON i.id = a.interview_id
    JOIN applications ap ON ap.id = i.application_id
    JOIN job_postings jp ON jp.id = ap.job_posting_id
    WHERE a.kind = 'decode'
)
DELETE FROM coaching_artifacts a
USING mapped m
WHERE a.id = m.id AND m.rn > 1;

-- Re-point the survivors at their posting. interview_id is cleared so the row
-- has exactly one scope — a decode that still claimed a round would show up on
-- that round's prep page and nowhere else, which is the bug being fixed.
UPDATE coaching_artifacts a
SET job_posting_id = jp.id,
    interview_id   = NULL
FROM interviews i
JOIN applications ap ON ap.id = i.application_id
JOIN job_postings jp ON jp.id = ap.job_posting_id
WHERE a.interview_id = i.id
  AND a.kind = 'decode'
  AND a.job_posting_id IS NULL;

-- A decode whose round had no application (or whose posting is gone) can't be
-- re-scoped and would sit unreachable forever. Drop it — it's regenerable.
DELETE FROM coaching_artifacts
WHERE kind = 'decode' AND job_posting_id IS NULL;

-- Uniqueness now spans both scopes. Same COALESCE-to-nil-uuid trick as before:
-- a plain UNIQUE treats every NULL as distinct, which would let `progress`
-- rows pile up and let one posting accumulate a decode per round again.
DROP INDEX IF EXISTS idx_coaching_artifacts_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coaching_artifacts_unique
    ON coaching_artifacts(
        user_id, kind,
        COALESCE(interview_id,   '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(job_posting_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX IF NOT EXISTS idx_coaching_artifacts_posting
    ON coaching_artifacts(user_id, job_posting_id) WHERE job_posting_id IS NOT NULL;

-- Exactly one scope per row, enforced rather than assumed — the backfill above
-- had to clear interview_id by hand precisely because nothing stopped a row
-- claiming two.
ALTER TABLE coaching_artifacts DROP CONSTRAINT IF EXISTS coaching_artifacts_one_scope;
ALTER TABLE coaching_artifacts ADD CONSTRAINT coaching_artifacts_one_scope
    CHECK (interview_id IS NULL OR job_posting_id IS NULL);

-- ============================================================================
-- B. the storybank becomes the one story library
-- ============================================================================

-- The variant titles that were folded into this story. Consolidation is
-- re-runnable, and on the second pass it has to recognise "Steerage Metric
-- Definition → Changed Product Experimentation" as already living inside
-- "Steerage metric at Garner" — otherwise every run re-creates the variants it
-- just merged away. This is that memory, and it's also the audit trail: it
-- names what got absorbed rather than silently dropping it.
ALTER TABLE coaching_stories ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

-- Which employer the story comes from. The candidate thinks in these terms
-- ("the Oscar one, not the Garner one") and two stories can otherwise read
-- almost identically — reconfiguring a team at Garner vs. managing someone out
-- at Oscar are both "hard people call".
ALTER TABLE coaching_stories ADD COLUMN IF NOT EXISTS company TEXT;

-- What's missing before this is tellable. Distinct from a low strength score:
-- strength says "this story is weak", sharpen says "this story is strong and
-- one number short". That note already exists in the synthesis data ("attach a
-- dollar figure — 3% of cancer spend = $X annualized") and had nowhere to live.
ALTER TABLE coaching_stories ADD COLUMN IF NOT EXISTS sharpen TEXT;

-- An anchor is a story the candidate named as one they keep coming back to.
-- Consolidation merges variants INTO anchors and never merges an anchor away,
-- so the library ends up under the candidate's own names rather than whichever
-- title a model invented last.
ALTER TABLE coaching_stories ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN NOT NULL DEFAULT false;

-- 'consolidation' joins the provenance set — a story assembled from several
-- past syntheses is neither a fresh synthesis nor hand-entered, and telling
-- them apart is what makes a second consolidation run safe.
ALTER TABLE coaching_stories DROP CONSTRAINT IF EXISTS coaching_stories_source_check;
ALTER TABLE coaching_stories ADD CONSTRAINT coaching_stories_source_check
    CHECK (source IN ('manual', 'synthesis', 'mock', 'mcp', 'consolidation'));

-- Alias lookup is how consolidation and upsert_story find the story a variant
-- title already belongs to.
CREATE INDEX IF NOT EXISTS idx_coaching_stories_aliases
    ON coaching_stories USING GIN (aliases);

-- ============================================================================
-- C. outcome reconciliation — "I checked this one, it's right"
-- ============================================================================
-- get_outcome_reconciliation flags rounds whose verdict disagrees with what
-- happened to the application: the app is rejected but its furthest round still
-- says 'advance'. Usually that's stale optimism and the fix is to correct the
-- round.
--
-- But not always, and that's exactly why this column exists. A round can
-- genuinely have gone well and the loop still die — the budget went, the req was
-- pulled, they promoted internally. In that case 'advance' on the round and
-- 'rejected' on the application are BOTH correct and there is nothing to fix.
-- Without somewhere to record "reviewed, it's fine", that row would reappear at
-- the top of the reconcile list forever and the only way to silence it would be
-- to write a loss that didn't happen.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS outcome_reviewed_at TIMESTAMPTZ;
