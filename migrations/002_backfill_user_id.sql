-- Migration 002 — consolidate user_id onto your web-login account
-- ============================================================================
-- The system had TWO identities writing data:
--   • the MCP wrote under its DEFAULT_USER_ID = 04e23c01-1346-4e2f-9ccd-9ccf458d65d3
--     (31 roles intaked via Claude landed here)
--   • the web app signs in (hannahgwilson@gmail.com) as auth.uid()
--     = d5eb8f0d-bee5-4fd8-a619-01d2dcf4aa4e   (1 role added via the web form)
-- Because RLS only returns rows where user_id = auth.uid(), the dashboard saw
-- only the 1 web role and none of the 31 MCP roles.
--
-- The web-login id is the one you can't change (Supabase Auth ties it to your
-- email), so we consolidate everything onto it: d5eb8f0d. This re-homes all
-- job-hunt rows (and the organizations they reference) onto v_user. Single-user
-- personal tool, so claiming *all* job-hunt rows is correct.
--
-- PAIR THIS WITH repointing the MCP so future writes match (otherwise new roles
-- drift back to 04e23c01):
--   supabase secrets set DEFAULT_USER_ID=d5eb8f0d-bee5-4fd8-a619-01d2dcf4aa4e
--   supabase functions deploy job-hunt-mcp --no-verify-jwt
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run. The editor runs as a privileged
--   role, so RLS won't block these updates.
--
-- Idempotent: re-running it is a no-op once everything already points at v_user.
-- ============================================================================

DO $$
DECLARE
    -- 👇 Your auth user id (from Supabase Auth → Users).
    v_user uuid := 'd5eb8f0d-bee5-4fd8-a619-01d2dcf4aa4e';

    n_postings  int;
    n_apps      int;
    n_history   int;
    n_interviews int;
    n_orgs      int;
    n_merged    int;
BEGIN
    -- Guard: refuse to run with the placeholder or the seed's zero-uuid.
    IF v_user IS NULL
       OR v_user = '00000000-0000-0000-0000-000000000000'
       OR v_user::text = '__YOUR_AUTH_USER_ID__' THEN
        RAISE EXCEPTION
          'Set v_user to your real auth user id before running (see header).';
    END IF;

    -- Organizations need MERGE, not a blind move: organizations has a unique
    -- (user_id, lower(name)) constraint, and you may already have a v_user-owned
    -- org with the same name as one of the MCP's (e.g. both "Anthropic"). Moving
    -- the MCP copy would collide, so:

    -- 1. Where a same-name org already exists under v_user, repoint the postings
    --    onto that existing org. The old (duplicate) org is left where it is —
    --    now orphaned by job_postings, harmless under its old id.
    UPDATE job_postings jp
       SET organization_id = tgt.id
      FROM organizations src
      JOIN organizations tgt
        ON tgt.user_id = v_user
       AND lower(tgt.name) = lower(src.name)
       AND tgt.id <> src.id
     WHERE jp.organization_id = src.id
       AND src.user_id IS DISTINCT FROM v_user;
    GET DIAGNOSTICS n_merged = ROW_COUNT;

    -- 2. The remaining referenced orgs have no same-name twin under v_user, so
    --    just move them. Scoped to referenced orgs so we don't disturb orgs
    --    owned by other extensions.
    UPDATE organizations o
       SET user_id = v_user
     WHERE o.user_id IS DISTINCT FROM v_user
       AND o.id IN (SELECT DISTINCT organization_id FROM job_postings)
       AND NOT EXISTS (
             SELECT 1 FROM organizations t
              WHERE t.user_id = v_user
                AND lower(t.name) = lower(o.name)
                AND t.id <> o.id
       );
    GET DIAGNOSTICS n_orgs = ROW_COUNT;

    -- Job-hunt-specific tables: claim everything.
    UPDATE job_postings              SET user_id = v_user WHERE user_id IS DISTINCT FROM v_user;
    GET DIAGNOSTICS n_postings = ROW_COUNT;

    UPDATE applications              SET user_id = v_user WHERE user_id IS DISTINCT FROM v_user;
    GET DIAGNOSTICS n_apps = ROW_COUNT;

    UPDATE application_status_history SET user_id = v_user WHERE user_id IS DISTINCT FROM v_user;
    GET DIAGNOSTICS n_history = ROW_COUNT;

    UPDATE interviews                SET user_id = v_user WHERE user_id IS DISTINCT FROM v_user;
    GET DIAGNOSTICS n_interviews = ROW_COUNT;

    RAISE NOTICE 'Backfilled to %: % postings repointed to existing orgs, % orgs moved, % postings, % applications, % history rows, % interviews.',
        v_user, n_merged, n_orgs, n_postings, n_apps, n_history, n_interviews;
END $$;
