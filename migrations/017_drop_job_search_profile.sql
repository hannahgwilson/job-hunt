-- Migration 017: drop the dead job_search_profile table
--
-- job_search_profile (migration 003) was the single-row resume store. Migration
-- 004 introduced the `resumes` dim and backfilled it from job_search_profile;
-- get_resume / upsert_resume have read/written `resumes` ever since. The old
-- table has been dead weight (unused, but still carrying RLS + a trigger).
--
-- GUARDED: refuses to drop if any user still has profile resume_text that was
-- never migrated into `resumes` (i.e. the 004 backfill didn't run for them), so
-- running this can't silently lose data. Verified safe on the live DB before
-- authoring (orphaned_if_dropped = 0).

DO $$
DECLARE
    v_orphans int;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'job_search_profile'
    ) THEN
        RAISE NOTICE 'job_search_profile already absent — nothing to do.';
        RETURN;
    END IF;

    SELECT count(*) INTO v_orphans
    FROM job_search_profile p
    WHERE coalesce(length(trim(p.resume_text)), 0) > 0
      AND NOT EXISTS (SELECT 1 FROM resumes r WHERE r.user_id = p.user_id);

    IF v_orphans > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop job_search_profile: % user(s) have profile text not present in resumes. Run the migration 004 backfill first.',
            v_orphans;
    END IF;

    DROP TABLE job_search_profile;   -- drops its RLS policy + updated_at trigger with it
    RAISE NOTICE 'Dropped job_search_profile (superseded by the resumes dim).';
END $$;
