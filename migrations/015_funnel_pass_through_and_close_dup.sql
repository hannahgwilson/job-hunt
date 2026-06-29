-- 015_funnel_pass_through_and_close_dup.sql
-- ============================================================================
-- Two new funnel/stage metrics, served by the EXISTING get_funnel_metrics (the
-- semantic layer's funnel function — see semantic/metrics/) rather than a new
-- bespoke function:
--   * pass_through          — decision-conditioned advance rate per stage
--                             (moved_on / (moved_on + rejected_here); pending
--                             kept aside).  semantic/metrics/pass_through_rate.yaml
--   * median_days_in_stage  — median dwell WITHIN a stage (entered → left),
--                             distinct from the cumulative time_in_stage.
--                             semantic/metrics/days_in_stage.yaml
-- Plus 'duplicate' as a job_postings.closed_reason (close a role as a dupe).
-- Re-runnable. get_funnel_metrics is mirrored in functions.sql (canonical).
-- ============================================================================

-- ── close a role as a duplicate ──────────────────────────────────────────────
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_closed_reason_check;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_closed_reason_check
    CHECK (closed_reason IN ('filled', 'expired', 'removed', 'no_longer_interested', 'duplicate', 'other')
           OR closed_reason IS NULL);


-- ── extend get_funnel_metrics with pass_through + median_days_in_stage ────────
-- get_funnel_metrics — the funnel/stage metric server. Computes FOUR semantic
-- metrics from application_status_history (see semantic/metrics/*.yaml):
--   * conversion_rates          → metrics/conversion_rate.yaml  (reached-based)
--   * median_days_from_applied  → metrics/time_in_stage.yaml    (cumulative)
--   * pass_through              → metrics/pass_through_rate.yaml (decision-based)
--   * median_days_in_stage      → metrics/days_in_stage.yaml     (per-stage dwell)
-- conversion_rate and pass_through differ on the denominator: conversion divides
-- by everyone who EVER reached a stage (pending included, so it drifts);
-- pass_through divides by those who got a VERDICT there (moved on or died),
-- keeping the still-waiting apps aside. Likewise time_in_stage is cumulative from
-- 'applied' while days_in_stage is the dwell within a single stage.
CREATE OR REPLACE FUNCTION get_funnel_metrics(
    p_window_days int DEFAULT NULL,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH hist AS (
        -- first time each application reached each status
        SELECT application_id, to_status, MIN(changed_at) AS reached_at
        FROM application_status_history
        WHERE user_id = p_user_id
          AND (p_window_days IS NULL
               OR changed_at >= now() - make_interval(days => p_window_days))
        GROUP BY application_id, to_status
    ),
    stages AS (
        SELECT * FROM (VALUES
            ('applied', 1, 'screening'), ('screening', 2, 'interviewing'),
            ('interviewing', 3, 'offer'), ('offer', 4, 'accepted'),
            ('accepted', 5, NULL)
        ) AS s(stage, ord, next_stage)
    ),
    counts AS (
        SELECT s.stage, s.ord, COUNT(DISTINCT h.application_id) AS cnt
        FROM stages s
        LEFT JOIN hist h ON h.to_status = s.stage
        GROUP BY s.stage, s.ord
    ),
    applied AS (
        SELECT application_id, reached_at AS applied_at
        FROM hist WHERE to_status = 'applied'
    ),
    days AS (
        SELECT s.stage,
               EXTRACT(EPOCH FROM (h.reached_at - a.applied_at)) / 86400.0 AS d
        FROM stages s
        JOIN hist h ON h.to_status = s.stage
        JOIN applied a ON a.application_id = h.application_id
        WHERE s.stage <> 'applied'
    ),
    medians AS (
        SELECT s.stage,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.d) AS med
        FROM stages s
        LEFT JOIN days d ON d.stage = s.stage
        WHERE s.stage <> 'applied'
        GROUP BY s.stage
    ),
    -- ── pass_through + days_in_stage: classify each (app, stage-it-reached) by
    --    whether it moved on, died there, or is still pending a decision ───────
    terminal AS (
        SELECT application_id, MAX(changed_at) AS ended_at
        FROM application_status_history
        WHERE user_id = p_user_id AND to_status IN ('rejected', 'withdrawn')
        GROUP BY application_id
    ),
    cur AS (
        SELECT id, status FROM applications WHERE user_id = p_user_id
    ),
    classified AS (
        SELECT
            s.stage, s.ord, (s.next_stage IS NOT NULL) AS has_next,
            (hn.reached_at IS NOT NULL) AS moved_on,
            (hn.reached_at IS NULL AND c.status IN ('rejected', 'withdrawn')) AS terminated_here,
            (hn.reached_at IS NULL
             AND c.status NOT IN ('rejected', 'withdrawn', 'closed', 'accepted', 'draft')) AS pending,
            CASE
                WHEN hn.reached_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (hn.reached_at - h.reached_at)) / 86400.0
                WHEN c.status IN ('rejected', 'withdrawn') AND t.ended_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (t.ended_at - h.reached_at)) / 86400.0
                ELSE NULL   -- still in-stage: dwell not final yet, excluded from median
            END AS dwell_days
        FROM stages s
        JOIN hist h        ON h.to_status = s.stage
        LEFT JOIN hist hn  ON hn.application_id = h.application_id AND hn.to_status = s.next_stage
        LEFT JOIN terminal t ON t.application_id = h.application_id
        JOIN cur c         ON c.id = h.application_id
    ),
    stage_agg AS (
        SELECT
            s.stage, s.ord, (s.next_stage IS NOT NULL) AS has_next,
            count(cl.*) AS total_ever,
            count(*) FILTER (WHERE cl.moved_on)        AS moved_on,
            count(*) FILTER (WHERE cl.terminated_here) AS terminated_here,
            count(*) FILTER (WHERE cl.pending)         AS pending,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cl.dwell_days) AS median_dwell
        FROM stages s
        LEFT JOIN classified cl ON cl.stage = s.stage
        GROUP BY s.stage, s.ord, s.next_stage
    )
    SELECT jsonb_build_object(
        'success', true,
        'window_days', p_window_days,
        'sample_size', (SELECT COUNT(DISTINCT application_id) FROM hist),
        'stage_counts', (SELECT jsonb_object_agg(stage, cnt) FROM counts),
        'conversion_rates', (
            SELECT jsonb_object_agg(stage_pair, rate)
            FROM (
                SELECT lag(c.stage) OVER (ORDER BY c.ord) || '_to_' || c.stage AS stage_pair,
                       lag(c.cnt)   OVER (ORDER BY c.ord) AS prev_cnt,
                       CASE WHEN lag(c.cnt) OVER (ORDER BY c.ord) > 0
                            THEN round(c.cnt::numeric / lag(c.cnt) OVER (ORDER BY c.ord), 3)
                            ELSE NULL END AS rate
                FROM counts c
            ) conv
            WHERE conv.prev_cnt IS NOT NULL
        ),
        'median_days_from_applied', (
            SELECT jsonb_object_agg(stage, CASE WHEN med IS NULL THEN NULL ELSE round(med::numeric, 1) END)
            FROM medians
        ),
        -- pass_through_rate.yaml — decision-conditioned advance rate per stage,
        -- with the raw counts so the UI can show "50% (1/2)" + pending aside.
        'pass_through', (
            SELECT jsonb_object_agg(stage, jsonb_build_object(
                'total_ever', total_ever,
                'moved_on', moved_on,
                'terminated_here', terminated_here,
                'pending', pending,
                'rate', CASE WHEN has_next AND (moved_on + terminated_here) > 0
                             THEN round(moved_on::numeric / (moved_on + terminated_here), 3)
                             ELSE NULL END
            ))
            FROM stage_agg
        ),
        -- days_in_stage.yaml — median dwell WITHIN each stage (entered → left).
        'median_days_in_stage', (
            SELECT jsonb_object_agg(stage,
                CASE WHEN median_dwell IS NULL THEN NULL ELSE round(median_dwell::numeric, 1) END)
            FROM stage_agg
        )
    ) INTO result;

    RETURN result;
END;
$$;

