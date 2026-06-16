-- Migration 005 — company-page fields on the shared organizations dim
-- ============================================================================
-- The company page wants a short blurb and a couple of links per employer.
-- organizations is a SHARED dim (also used by family-calendar / CRM), so this
-- migration is strictly ADDITIVE: ADD COLUMN IF NOT EXISTS only — it never
-- drops or rewrites anything, and is safe to re-run. If the org schema later
-- adds its own equivalents, reconcile then; for now these are the canonical
-- home for the job-hunt company page's blurb + links.
--
-- These columns are NOT in this repo's schema.sql because organizations is
-- owned by the organizations schema, not job-hunt.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS description TEXT;   -- short blurb
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website_url TEXT;   -- homepage
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS culture_url TEXT;   -- careers / culture page
