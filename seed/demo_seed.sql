-- Demo seed — fictional data so the tracking hub is browsable in screenshots
-- and a fresh clone, WITHOUT any real personal data.
--
-- Real job-search data lives only in your Supabase project; this file is the
-- public, fake version. Everything here is invented.
--
-- Usage: in the Supabase SQL editor, set v_user to the auth user id you sign in
-- as (the same id the MCP uses as DEFAULT_USER_ID), then run. Re-runnable-ish:
-- it always inserts, so run against an empty/demo database.

DO $$
DECLARE
    v_user uuid := '00000000-0000-0000-0000-000000000000';  -- <-- REPLACE with your auth user id

    org_acme   uuid;
    org_globex uuid;
    org_initech uuid;

    post_acme_eng   uuid;
    post_globex_pm  uuid;
    post_initech_ds uuid;
    post_acme_lead  uuid;

    app_acme   uuid;
    app_globex uuid;
    app_initech uuid;
BEGIN
    -- Organizations
    INSERT INTO organizations (user_id, name, industry, tags)
    VALUES (v_user, 'Acme AI', 'Artificial Intelligence', ARRAY['employer-target'])
    RETURNING id INTO org_acme;

    INSERT INTO organizations (user_id, name, industry, tags)
    VALUES (v_user, 'Globex', 'Enterprise Software', ARRAY['employer-target'])
    RETURNING id INTO org_globex;

    INSERT INTO organizations (user_id, name, industry, tags)
    VALUES (v_user, 'Initech', 'FinTech', ARRAY['employer-target'])
    RETURNING id INTO org_initech;

    -- Job postings
    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source)
    VALUES (v_user, org_acme, 'Senior AI Engineer', 'https://example.com/acme/sai', 190000, 240000, 'Remote', 'remote', 'linkedin')
    RETURNING id INTO post_acme_eng;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source)
    VALUES (v_user, org_globex, 'Group Product Manager', 'https://example.com/globex/gpm', 180000, 220000, 'New York, NY', 'hybrid', 'referral')
    RETURNING id INTO post_globex_pm;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source)
    VALUES (v_user, org_initech, 'Staff Data Scientist', 'https://example.com/initech/sds', 200000, 250000, 'Austin, TX', 'onsite', 'company-site')
    RETURNING id INTO post_initech_ds;

    -- A tracked posting with NO application yet -> shows in "roles to apply"
    INSERT INTO job_postings (user_id, organization_id, title, url, remote_policy, source, closing_date)
    VALUES (v_user, org_acme, 'AI Research Lead', 'https://example.com/acme/lead', 'remote', 'linkedin', current_date + 4)
    RETURNING id INTO post_acme_lead;

    -- Applications (the status-history trigger logs the current state on insert)
    INSERT INTO applications (user_id, job_posting_id, status, applied_date)
    VALUES (v_user, post_acme_eng, 'interviewing', current_date - 20)
    RETURNING id INTO app_acme;

    INSERT INTO applications (user_id, job_posting_id, status, applied_date)
    VALUES (v_user, post_globex_pm, 'screening', current_date - 12)
    RETURNING id INTO app_globex;

    INSERT INTO applications (user_id, job_posting_id, status, applied_date, response_date)
    VALUES (v_user, post_initech_ds, 'rejected', current_date - 30, current_date - 18)
    RETURNING id INTO app_initech;

    -- Backdated status history so the funnel has realistic time-in-stage.
    -- (The insert trigger added a now() row at each app's current status; these
    -- earlier rows give MIN(changed_at) per stage = the real progression.)
    INSERT INTO application_status_history (user_id, application_id, from_status, to_status, changed_at) VALUES
        (v_user, app_acme,   NULL,           'applied',      now() - interval '20 days'),
        (v_user, app_acme,   'applied',      'screening',    now() - interval '15 days'),
        (v_user, app_acme,   'screening',    'interviewing', now() - interval '9 days'),
        (v_user, app_globex, NULL,           'applied',      now() - interval '12 days'),
        (v_user, app_globex, 'applied',      'screening',    now() - interval '6 days'),
        (v_user, app_initech, NULL,          'applied',      now() - interval '30 days'),
        (v_user, app_initech, 'applied',     'screening',    now() - interval '24 days'),
        (v_user, app_initech, 'screening',   'rejected',     now() - interval '18 days');

    -- An upcoming interview for the Acme role -> shows on Dashboard + queue
    INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, duration_minutes, status, notes)
    VALUES (v_user, app_acme, 'hiring_manager', now() + interval '3 days', 45, 'scheduled', 'Prep: system design + past project deep dive.');

    -- A completed earlier round with a go/no-go decision -> shows on role detail
    INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, status, rating, feedback, advance_decision, decision_notes)
    VALUES (v_user, app_acme, 'phone_screen', now() - interval '8 days', 'completed', 4,
            'Strong rapport with the recruiter; role scope matches well.', 'advance', 'Clear yes — move to hiring-manager round.');
END $$;
