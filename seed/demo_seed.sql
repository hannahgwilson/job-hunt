-- Demo seed — fictional data so the whole app is alive for a demo recording or
-- screenshots, WITHOUT any real personal data. Everything here is invented.
--
-- Populates: 15 roles across 10 companies (a force-ranked apply queue + a kanban
-- spread across every stage), 2 résumés (an IC and a manager variant), a bullet
-- library, applications with a backdated history (so the funnel has real
-- time-in-stage), interviews (one upcoming, some completed), pre-scored résumé
-- fits — including a deliberate IC-résumé-vs-manager-role track mismatch — and a
-- cached feedback synthesis. A few roles are left un-judged on purpose so you can
-- demo "Run AI judge" / "Judge N un-judged" live.
--
-- ── Setup ────────────────────────────────────────────────────────────────────
-- 1. Create the demo auth user (Supabase Dashboard → Authentication → Users →
--    Add user): email demo@jobhunt.test, and check "Auto Confirm User". No
--    password needed — you'll sign in with a magic link.
-- 2. Run this file in the Supabase SQL editor. It finds that user by email, wipes
--    any prior demo data for them, and reseeds — so it's safe to re-run.
-- 3. Sign in to the dashboard as demo@jobhunt.test (magic link) and record.
--
-- (Prefer a different email or a raw uuid? Edit the SELECT … INTO v_user below.)

DO $$
DECLARE
    v_user uuid;

    -- organizations
    o_lumen uuid; o_cobalt uuid; o_meridian uuid; o_driftwood uuid; o_northwind uuid;
    o_paloma uuid; o_verdant uuid; o_quanta uuid; o_brightwave uuid; o_helio uuid;

    -- postings (referenced later for apps / fits)
    p_lumen_sds uuid; p_lumen_lead uuid; p_cobalt_ae uuid; p_cobalt_dir uuid;
    p_meridian_ml uuid; p_driftwood_head uuid; p_northwind_mgr uuid; p_northwind_ds uuid;
    p_paloma_principal uuid; p_paloma_dir uuid; p_verdant_lead uuid; p_quanta_ml uuid;
    p_brightwave_ds uuid; p_brightwave_growth uuid; p_helio_mgr uuid;

    -- résumés
    r_ic uuid; r_mgr uuid;

    -- applications
    a_lumen uuid; a_paloma uuid; a_meridian uuid; a_driftwood uuid; a_helio uuid; a_quanta uuid;
BEGIN
    SELECT id INTO v_user FROM auth.users WHERE email = 'demo@jobhunt.test';
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Create the auth user demo@jobhunt.test first (Dashboard → Authentication → Add user, Auto Confirm).';
    END IF;

    -- ── clean slate for this demo user (children first) ──────────────────────
    DELETE FROM interviews                 WHERE user_id = v_user;
    DELETE FROM applications               WHERE user_id = v_user;  -- cascades status history
    DELETE FROM role_fit                   WHERE user_id = v_user;
    DELETE FROM assembled_resumes          WHERE user_id = v_user;
    DELETE FROM resume_feedback_synthesis  WHERE user_id = v_user;
    DELETE FROM resume_bullets             WHERE user_id = v_user;
    DELETE FROM job_postings               WHERE user_id = v_user;
    DELETE FROM resumes                    WHERE user_id = v_user;
    DELETE FROM priority_weights           WHERE user_id = v_user;
    DELETE FROM organizations              WHERE user_id = v_user AND tags && ARRAY['employer-target'];

    -- ── organizations ────────────────────────────────────────────────────────
    INSERT INTO organizations (user_id, name, industry, description, website_url, tags) VALUES
        (v_user, 'Lumen Labs',        'Artificial Intelligence', 'Applied-AI startup building decision tools.', 'https://example.com/lumen',     ARRAY['employer-target']) RETURNING id INTO o_lumen;
    INSERT INTO organizations (user_id, name, industry, description, website_url, tags) VALUES
        (v_user, 'Cobalt Analytics',  'Data & Analytics',        'Analytics platform for mid-market ops.',      'https://example.com/cobalt',    ARRAY['employer-target']) RETURNING id INTO o_cobalt;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Meridian Health AI','Healthcare AI', ARRAY['employer-target']) RETURNING id INTO o_meridian;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Driftwood',         'Consumer', ARRAY['employer-target']) RETURNING id INTO o_driftwood;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Northwind Robotics','Robotics', ARRAY['employer-target']) RETURNING id INTO o_northwind;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Paloma',            'FinTech', ARRAY['employer-target']) RETURNING id INTO o_paloma;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Verdant Bio',       'BioTech', ARRAY['employer-target']) RETURNING id INTO o_verdant;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Quanta Systems',    'Data Infrastructure', ARRAY['employer-target']) RETURNING id INTO o_quanta;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Brightwave',        'Marketing Technology', ARRAY['employer-target']) RETURNING id INTO o_brightwave;
    INSERT INTO organizations (user_id, name, industry, tags) VALUES
        (v_user, 'Helio Energy',      'CleanTech', ARRAY['employer-target']) RETURNING id INTO o_helio;

    -- ── job postings ─────────────────────────────────────────────────────────
    -- Signals (experience_alignment / career_trajectory / growth_stage / role_type)
    -- are set on most so the queue ranks visibly; a few are left null on purpose
    -- so "Run AI judge" / the un-judged backfill has something to do on camera.

    -- IC roles
    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_lumen, 'Senior Data Scientist', 'https://example.com/lumen/sds', 185000, 225000, 'New York, NY', 'hybrid', 'linkedin',
            ARRAY['5+ yrs applied ML','Python','experimentation / causal inference','production models'], 0.88, 'step_up', 'growth', 'ic') RETURNING id INTO p_lumen_sds;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, closing_date, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_cobalt, 'Analytics Engineer', 'https://example.com/cobalt/ae', 160000, 195000, 'Remote', 'remote', 'company-site', current_date + 9,
            ARRAY['dbt','SQL','data modeling','BI / semantic layer'], 0.83, 'lateral', 'growth', 'ic') RETURNING id INTO p_cobalt_ae;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_quanta, 'Staff ML Engineer', 'https://example.com/quanta/staff-ml', 210000, 260000, 'Remote', 'remote', 'referral',
            ARRAY['MLOps','distributed training','Python/Go','platform ownership'], 0.79, 'step_up', 'growth', 'ic') RETURNING id INTO p_quanta_ml;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_paloma, 'Principal Data Scientist', 'https://example.com/paloma/principal', 220000, 270000, 'New York, NY', 'hybrid', 'linkedin',
            ARRAY['fraud / risk modeling','deep stats','mentorship','10+ yrs'], 0.81, 'step_up', 'late', 'ic') RETURNING id INTO p_paloma_principal;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_meridian, 'Senior ML Engineer', 'https://example.com/meridian/sml', 175000, 210000, 'Boston, MA', 'onsite', 'company-site',
            ARRAY['healthcare data','model deployment','HIPAA','Python'], 0.62, 'lateral', 'early', 'ic') RETURNING id INTO p_meridian_ml;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements)
    VALUES (v_user, o_brightwave, 'Data Scientist, Marketing', 'https://example.com/brightwave/ds', 150000, 180000, 'Remote', 'remote', 'linkedin',
            ARRAY['marketing mix modeling','SQL','A/B testing']) RETURNING id INTO p_brightwave_ds;  -- left UN-judged

    -- Manager roles
    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, closing_date, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_cobalt, 'Director of Analytics', 'https://example.com/cobalt/dir', 210000, 250000, 'New York, NY', 'hybrid', 'referral', current_date + 5,
            ARRAY['lead a team of 6+','analytics strategy','exec stakeholders','hiring'], 0.84, 'step_up', 'growth', 'manager') RETURNING id INTO p_cobalt_dir;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_driftwood, 'Head of Data Science', 'https://example.com/driftwood/head', 230000, 280000, 'Remote', 'remote', 'recruiter',
            ARRAY['build & lead the DS function','roadmap','3+ yrs management'], 0.86, 'step_up', 'growth', 'manager') RETURNING id INTO p_driftwood_head;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_northwind, 'Manager, Data Science', 'https://example.com/northwind/mgr', 195000, 235000, 'San Francisco, CA', 'onsite', 'linkedin',
            ARRAY['manage 4-5 DS','robotics / sensor data','quarterly planning'], 0.58, 'step_up', 'early', 'manager') RETURNING id INTO p_northwind_mgr;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_helio, 'Senior Manager, Decision Science', 'https://example.com/helio/smds', 200000, 240000, 'Denver, CO', 'hybrid', 'company-site',
            ARRAY['decision science leadership','optimization','energy markets'], 0.74, 'step_up', 'growth', 'manager') RETURNING id INTO p_helio_mgr;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements)
    VALUES (v_user, o_paloma, 'Director, Data Science & ML', 'https://example.com/paloma/dir', 240000, 300000, 'New York, NY', 'hybrid', 'referral',
            ARRAY['lead DS + ML org','risk domain','VP-track']) RETURNING id INTO p_paloma_dir;  -- left UN-judged

    -- Hybrid / lead
    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage, role_type)
    VALUES (v_user, o_lumen, 'Lead Data Scientist', 'https://example.com/lumen/lead', 200000, 245000, 'New York, NY', 'hybrid', 'linkedin',
            ARRAY['player-coach','lead 2-3 ICs','still hands-on','applied ML'], 0.80, 'step_up', 'growth', 'hybrid') RETURNING id INTO p_lumen_lead;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements)
    VALUES (v_user, o_verdant, 'Analytics Lead', 'https://example.com/verdant/lead', 165000, 200000, 'Cambridge, MA', 'onsite', 'company-site',
            ARRAY['lab data','team of 2','R / Python']) RETURNING id INTO p_verdant_lead;  -- left UN-judged

    -- Unclear / other
    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements, experience_alignment, career_trajectory, growth_stage)
    VALUES (v_user, o_northwind, 'Decision Scientist', 'https://example.com/northwind/decsci', 170000, 205000, 'Remote', 'remote', 'linkedin',
            ARRAY['optimization','simulation','stakeholder comms'], 0.71, 'lateral', 'early') RETURNING id INTO p_northwind_ds;

    INSERT INTO job_postings (user_id, organization_id, title, url, salary_min, salary_max, location, remote_policy, source, requirements)
    VALUES (v_user, o_brightwave, 'Head of Growth Analytics', 'https://example.com/brightwave/growth', 195000, 235000, 'Remote', 'remote', 'recruiter',
            ARRAY['growth analytics','lead analysts','marketing + product']) RETURNING id INTO p_brightwave_growth;  -- left UN-judged

    -- ── résumés ──────────────────────────────────────────────────────────────
    INSERT INTO resumes (user_id, label, variant, is_default, resume_text) VALUES
    (v_user, 'Senior IC — Data Science', 'ic', true,
$res$Jordan Rivera — Senior Data Scientist
New York, NY · jordan.rivera@example.com

SUMMARY
Senior data scientist (8 yrs) shipping production ML and causal/experimentation
work that moves business metrics. Deep in Python, SQL, and modern data tooling.

EXPERIENCE
Cobalt Analytics — Senior Data Scientist (2021–present)
- Built a churn model that cut voluntary churn 14% and drove $3.2M retained ARR.
- Stood up the experimentation platform; 120+ A/B tests/quarter with guardrails.
- Mentored 3 junior DS; owned the forecasting pipeline end to end.

Driftwood — Data Scientist (2018–2021)
- Shipped the recommendation model behind the home feed (+9% engagement).
- Reduced model training time 60% by re-architecting the feature pipeline.

SKILLS
Python, SQL, dbt, PyTorch, causal inference, A/B testing, Airflow, Snowflake.$res$)
    RETURNING id INTO r_ic;

    INSERT INTO resumes (user_id, label, variant, is_default, resume_text) VALUES
    (v_user, 'Manager — Data/Analytics Leadership', 'manager', false,
$res$Jordan Rivera — Data Science Leader
New York, NY · jordan.rivera@example.com

SUMMARY
Data/analytics leader who builds and grows high-trust teams and ties their work
to P&L. 8 yrs in DS, 3 leading teams of 4–7 across analytics and ML.

EXPERIENCE
Cobalt Analytics — Data Science Manager (2021–present)
- Hired and led a team of 6 (DS + analytics eng); 2 promotions to senior.
- Owned the analytics roadmap with the exec team; set quarterly OKRs.
- Drove the churn + experimentation programs that retained $3.2M ARR.

Driftwood — Senior Data Scientist → Team Lead (2018–2021)
- Grew a 3-person pod; established the review and on-call practices.

SKILLS
People leadership, hiring, roadmapping, stakeholder management, DS/ML strategy.$res$)
    RETURNING id INTO r_mgr;

    -- ── bullet library (raw material for the JD-tailored generator) ───────────
    INSERT INTO resume_bullets (user_id, section, org_label, text, tags, sort_order, source) VALUES
    (v_user, 'Summary',    NULL,                          'Senior data scientist (8 yrs) shipping production ML and causal work that moves business metrics.', ARRAY['ic'], 1, 'manual'),
    (v_user, 'Summary',    NULL,                          'Data/analytics leader who builds high-trust teams and ties their work to P&L.', ARRAY['leadership'], 2, 'manual'),
    (v_user, 'Experience', 'Cobalt Analytics — Senior DS','Built a churn model that cut voluntary churn 14% and drove $3.2M retained ARR.', ARRAY['ml','impact'], 1, 'manual'),
    (v_user, 'Experience', 'Cobalt Analytics — Senior DS','Stood up the experimentation platform — 120+ A/B tests per quarter with guardrails.', ARRAY['experimentation'], 2, 'manual'),
    (v_user, 'Experience', 'Cobalt Analytics — Manager',  'Hired and led a team of 6 across DS and analytics engineering; two promotions to senior.', ARRAY['leadership','hiring'], 3, 'manual'),
    (v_user, 'Experience', 'Cobalt Analytics — Manager',  'Owned the analytics roadmap with the exec team and set quarterly OKRs.', ARRAY['leadership','strategy'], 4, 'manual'),
    (v_user, 'Experience', 'Driftwood — Data Scientist',  'Shipped the recommendation model behind the home feed (+9% engagement).', ARRAY['ml','impact'], 5, 'manual'),
    (v_user, 'Experience', 'Driftwood — Data Scientist',  'Cut model training time 60% by re-architecting the feature pipeline.', ARRAY['mlops'], 6, 'manual'),
    (v_user, 'Skills',     NULL,                          'Python, SQL, dbt, PyTorch, causal inference, A/B testing, Airflow, Snowflake.', ARRAY['ic'], 1, 'manual'),
    (v_user, 'Skills',     NULL,                          'People leadership, hiring, roadmapping, stakeholder management, DS/ML strategy.', ARRAY['leadership'], 2, 'manual');

    -- ── applications (spread across every stage) ─────────────────────────────
    INSERT INTO applications (user_id, job_posting_id, status, applied_date) VALUES
        (v_user, p_lumen_sds, 'interviewing', current_date - 22) RETURNING id INTO a_lumen;
    INSERT INTO applications (user_id, job_posting_id, status, applied_date) VALUES
        (v_user, p_paloma_principal, 'screening', current_date - 10) RETURNING id INTO a_paloma;
    INSERT INTO applications (user_id, job_posting_id, status, applied_date, response_date) VALUES
        (v_user, p_meridian_ml, 'rejected', current_date - 30, current_date - 18) RETURNING id INTO a_meridian;
    INSERT INTO applications (user_id, job_posting_id, status, applied_date) VALUES
        (v_user, p_driftwood_head, 'offer', current_date - 40) RETURNING id INTO a_driftwood;
    INSERT INTO applications (user_id, job_posting_id, status, applied_date, response_date) VALUES
        (v_user, p_helio_mgr, 'accepted', current_date - 38, current_date - 30) RETURNING id INTO a_helio;
    INSERT INTO applications (user_id, job_posting_id, status, applied_date) VALUES
        (v_user, p_quanta_ml, 'applied', current_date - 6) RETURNING id INTO a_quanta;

    -- Backdated status history → realistic funnel conversion + time-in-stage.
    -- (The insert trigger logged a now() row at each app's current status; replace
    -- those with a hand-built progression.)
    DELETE FROM application_status_history WHERE application_id IN
        (a_lumen, a_paloma, a_meridian, a_driftwood, a_helio, a_quanta);
    INSERT INTO application_status_history (user_id, application_id, from_status, to_status, changed_at) VALUES
        (v_user, a_lumen,    NULL,        'applied',      now() - interval '22 days'),
        (v_user, a_lumen,    'applied',   'screening',    now() - interval '15 days'),
        (v_user, a_lumen,    'screening', 'interviewing', now() - interval '7 days'),
        (v_user, a_paloma,   NULL,        'applied',      now() - interval '10 days'),
        (v_user, a_paloma,   'applied',   'screening',    now() - interval '3 days'),
        (v_user, a_meridian, NULL,        'applied',      now() - interval '30 days'),
        (v_user, a_meridian, 'applied',   'screening',    now() - interval '24 days'),
        (v_user, a_meridian, 'screening', 'rejected',     now() - interval '18 days'),
        (v_user, a_driftwood,NULL,        'applied',      now() - interval '40 days'),
        (v_user, a_driftwood,'applied',   'screening',    now() - interval '33 days'),
        (v_user, a_driftwood,'screening', 'interviewing', now() - interval '24 days'),
        (v_user, a_driftwood,'interviewing','offer',      now() - interval '9 days'),
        (v_user, a_helio,    NULL,        'applied',      now() - interval '38 days'),
        (v_user, a_helio,    'applied',   'screening',    now() - interval '31 days'),
        (v_user, a_helio,    'screening', 'interviewing', now() - interval '22 days'),
        (v_user, a_helio,    'interviewing','offer',      now() - interval '12 days'),
        (v_user, a_helio,    'offer',     'accepted',     now() - interval '4 days'),
        (v_user, a_quanta,   NULL,        'applied',      now() - interval '6 days');

    -- ── interviews ───────────────────────────────────────────────────────────
    INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, duration_minutes, status, notes) VALUES
        (v_user, a_lumen, 'hiring_manager', now() + interval '3 days', 45, 'scheduled', 'Prep: experimentation deep-dive + a recent production model.');
    INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, status, rating, feedback, advance_decision, decision_notes) VALUES
        (v_user, a_lumen, 'technical', now() - interval '6 days', 'completed', 4, 'Solid case on causal inference; good signal.', 'advance', 'Clear yes — move to hiring manager.');
    INSERT INTO interviews (user_id, application_id, interview_type, scheduled_at, status, rating, feedback, advance_decision, decision_notes) VALUES
        (v_user, a_driftwood, 'final', now() - interval '10 days', 'completed', 5, 'Great fit with the leadership team; offer expected.', 'advance', 'Offer stage.');

    -- ── pre-scored résumé fits (so fit / feedback / Insights are populated) ───
    -- Includes a deliberate track mismatch: the IC résumé scored against the
    -- Director role lands low, the manager résumé lands high → the role page
    -- shows the "⚠ track mismatch" flag.
    INSERT INTO role_fit (user_id, job_posting_id, resume_id, alignment, summary, spikes, gaps, tweaks, model) VALUES
    (v_user, p_lumen_sds, r_ic, 0.88, 'Strong IC match — production ML + experimentation line up directly with the JD.',
        '["Production ML ownership","Experimentation platform","Causal inference"]'::jsonb,
        '["No explicit LLM/GenAI work"]'::jsonb,
        '[{"section":"Summary","suggestion":"Lead with the $3.2M retained ARR number.","rationale":"Quantified impact clears both the human and ATS screen."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_quanta_ml, r_ic, 0.79, 'Good fit; platform/MLOps depth is a slight stretch vs the staff bar.',
        '["Feature pipeline re-architecture","Training-time wins"]'::jsonb,
        '["Distributed training not evidenced","No Go experience"]'::jsonb,
        '[{"section":"Skills","suggestion":"Name the orchestration + infra stack explicitly.","rationale":"The JD screens on MLOps keywords."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_cobalt_ae, r_ic, 0.83, 'dbt + modeling experience maps cleanly to the analytics-engineering scope.',
        '["dbt / data modeling","Semantic layer"]'::jsonb,
        '["Less BI-tool surface area"]'::jsonb,
        '[{"section":"Experience","suggestion":"Add a bullet on the semantic-layer / metrics work.","rationale":"Directly matches a core requirement."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_paloma_principal, r_ic, 0.81, 'Senior IC depth fits; risk/fraud domain is adjacent, not direct.',
        '["Deep stats","Mentorship"]'::jsonb,
        '["No fraud/risk domain"]'::jsonb,
        '[{"section":"Summary","suggestion":"Frame the churn/risk modeling as risk-adjacent.","rationale":"Bridges the domain gap for the screen."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_cobalt_dir, r_ic, 0.41, 'Track mismatch — this is a people-management role and the IC résumé leads with hands-on work, not team leadership.',
        '["Strong analytics craft"]'::jsonb,
        '["No team-leadership framing","No hiring / org-scope evidence up front"]'::jsonb,
        '[{"section":"Summary","suggestion":"Use the manager résumé variant for this role.","rationale":"A Director screen filters on leadership signal first."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_cobalt_dir, r_mgr, 0.84, 'Strong manager match — team leadership, hiring, and roadmap ownership are all evidenced.',
        '["Led a team of 6","Exec roadmap ownership","Hiring + promotions"]'::jsonb,
        '["Could quantify org-level impact more"]'::jsonb,
        '[{"section":"Experience","suggestion":"Add a headcount-growth / retention metric.","rationale":"Director screens reward measurable org outcomes."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_driftwood_head, r_mgr, 0.86, 'Excellent fit for building and leading the DS function.',
        '["Built/led DS team","Roadmap","Stakeholder mgmt"]'::jsonb,
        '["Function was mid-size, not from zero"]'::jsonb,
        '[{"section":"Summary","suggestion":"Emphasize standing up practices from early-stage.","rationale":"\"Head of\" implies building, not just running."}]'::jsonb,
        'claude-sonnet-4-6'),
    (v_user, p_helio_mgr, r_mgr, 0.80, 'Decision-science leadership fits; energy-markets domain is new.',
        '["DS leadership","Optimization-adjacent"]'::jsonb,
        '["No energy-markets background"]'::jsonb,
        '[{"section":"Experience","suggestion":"Surface any optimization / OR work.","rationale":"Closes the domain gap for decision science."}]'::jsonb,
        'claude-sonnet-4-6');

    -- ── cached feedback synthesis for the IC résumé (so the panel shows themes) ─
    INSERT INTO resume_feedback_synthesis (resume_id, user_id, headline, source_count, model, themes) VALUES
    (r_ic, v_user, 'Lead every role with a quantified impact number — it is your strongest, most-underused asset.', 4, 'claude-sonnet-4-6',
    '[
      {"title":"Quantify impact in the summary","category":"Summary","priority":"high","role_count":3,
       "recommendation":"Open the summary with the $3.2M retained ARR / 14% churn-reduction figures.",
       "rationale":"Recurred across roles; quantified impact clears both the human and the ATS screen.",
       "roles":["Senior Data Scientist · Lumen Labs","Analytics Engineer · Cobalt Analytics","Principal Data Scientist · Paloma"]},
      {"title":"Name the MLOps / infra stack explicitly","category":"Skills & keywords","priority":"high","role_count":2,
       "recommendation":"List orchestration, serving, and infra tools by name in the skills line.",
       "rationale":"Staff/platform roles keyword-screen on these and they are currently implicit.",
       "roles":["Staff ML Engineer · Quanta Systems"]},
      {"title":"Add a semantic-layer / metrics bullet","category":"Experience","priority":"medium","role_count":1,
       "recommendation":"Add an experience bullet on the metrics / semantic-layer work.",
       "rationale":"Directly matches a core analytics-engineering requirement.",
       "roles":["Analytics Engineer · Cobalt Analytics"]},
      {"title":"Use the manager variant for leadership roles","category":"Other","priority":"medium","role_count":1,
       "recommendation":"Do not submit the IC résumé to Director/Head roles — switch variants.",
       "rationale":"Track mismatch tanks the screen regardless of craft.",
       "roles":["Director of Analytics · Cobalt Analytics"]}
    ]'::jsonb);

    RAISE NOTICE 'Demo seed complete for % — 15 roles, 2 résumés, % bullets, 6 applications.', v_user, 10;
END $$;
