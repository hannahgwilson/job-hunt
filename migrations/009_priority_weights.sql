-- Migration 009 — user-adjustable priority weights
-- ============================================================================
-- Until now the five priority-component weights were a constant, duplicated in
-- three places (compute_priority's p_weights DEFAULT, semantic/metrics/
-- priority_score.yaml, and the web client's lib/priority.ts) and only re-tunable
-- by editing all three and redeploying. This makes them per-user data: a one-row
-- table the Pipeline page edits with sliders, read back into the force-ranking so
-- the queue re-sorts immediately and the MCP/agent see the same order.
--
-- The hardcoded '{"experience":0.35,...}' object stays as the *fallback* (no row
-- → neutral spec default), so nothing changes for a user who never touches the
-- sliders. compute_priority itself is unchanged — it already takes p_weights;
-- the ranking readers now resolve the user's row and pass it.
--
-- Functions (resolve_priority_weights / get_priority_weights /
-- save_priority_weights) plus the reworked get_action_queue / get_prioritized_roles
-- also live in functions.sql (CREATE OR REPLACE) — re-run it after this. The defs
-- are inlined here too so this migration applies standalone. Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS priority_weights (
    user_id     UUID PRIMARY KEY,
    experience  NUMERIC(4,3) NOT NULL DEFAULT 0.350,
    location    NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    comp        NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    career      NUMERIC(4,3) NOT NULL DEFAULT 0.200,
    growth      NUMERIC(4,3) NOT NULL DEFAULT 0.150,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- each lever in [0,1]; save_priority_weights normalizes the set to sum 1.0
    CONSTRAINT priority_weights_range CHECK (
        experience BETWEEN 0 AND 1 AND location BETWEEN 0 AND 1
        AND comp BETWEEN 0 AND 1 AND career BETWEEN 0 AND 1 AND growth BETWEEN 0 AND 1
    )
);

DROP TRIGGER IF EXISTS update_priority_weights_updated_at ON priority_weights;
CREATE TRIGGER update_priority_weights_updated_at
    BEFORE UPDATE ON priority_weights
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE priority_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS priority_weights_user_policy ON priority_weights;
CREATE POLICY priority_weights_user_policy ON priority_weights
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── resolve: the user's stored weights as the jsonb compute_priority wants, or
--    the neutral spec default when they've never set them. ─────────────────────
CREATE OR REPLACE FUNCTION resolve_priority_weights(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT jsonb_build_object(
            'experience', experience, 'location', location,
            'comp', comp, 'career', career, 'growth', growth)
         FROM priority_weights WHERE user_id = p_user_id),
        '{"experience":0.35,"location":0.15,"comp":0.15,"career":0.20,"growth":0.15}'::jsonb
    );
$$;

-- ── read: weights + whether they're customised (so the UI can show "default"). ─
CREATE OR REPLACE FUNCTION get_priority_weights(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'is_custom', EXISTS (SELECT 1 FROM priority_weights WHERE user_id = p_user_id),
        'weights', resolve_priority_weights(p_user_id)
    );
$$;

-- ── write: upsert one row, normalized so the five levers always sum to 1.0
--    (the UI sliders move freely; we rescale on save). ─────────────────────────
CREATE OR REPLACE FUNCTION save_priority_weights(
    p_experience numeric,
    p_location numeric,
    p_comp numeric,
    p_career numeric,
    p_growth numeric,
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_sum numeric;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'save_priority_weights: no user_id';
    END IF;
    v_sum := COALESCE(p_experience,0) + COALESCE(p_location,0) + COALESCE(p_comp,0)
           + COALESCE(p_career,0) + COALESCE(p_growth,0);
    IF v_sum <= 0 THEN
        RAISE EXCEPTION 'save_priority_weights: weights must sum to a positive value';
    END IF;

    INSERT INTO priority_weights (user_id, experience, location, comp, career, growth)
    VALUES (
        p_user_id,
        round(COALESCE(p_experience,0) / v_sum, 3),
        round(COALESCE(p_location,0)   / v_sum, 3),
        round(COALESCE(p_comp,0)       / v_sum, 3),
        round(COALESCE(p_career,0)     / v_sum, 3),
        round(COALESCE(p_growth,0)     / v_sum, 3)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        experience = EXCLUDED.experience,
        location   = EXCLUDED.location,
        comp       = EXCLUDED.comp,
        career     = EXCLUDED.career,
        growth     = EXCLUDED.growth,
        updated_at = now();

    RETURN get_priority_weights(p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_priority_weights(uuid)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_priority_weights(uuid)                           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_priority_weights(numeric, numeric, numeric, numeric, numeric, uuid) TO authenticated, service_role;

-- get_action_queue + get_prioritized_roles now resolve the caller's weights and
-- feed them to compute_priority. Re-run functions.sql to pick up those changes
-- (their bodies there are the canonical versions).
