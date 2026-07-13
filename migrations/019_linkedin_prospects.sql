-- Migration 019 — LinkedIn prospect contacts
-- ============================================================================
-- contacts is a shared dim (extensions/family-calendar); additive only, per
-- the precedent in 005_org_company_fields.sql. Adds a profile link so a
-- contact found via a LinkedIn hiring-manager search keeps its source URL.
--
-- No new "prospect" status column: an unconfirmed contact found via search is
-- just a contacts row tagged 'prospect' (alongside 'job-hunt'), per the tag
-- convention in CLAUDE.md. save_prospect_contact() / promote_prospect_contact()
-- in functions.sql read/write it that way — see those for the actual lifecycle.
-- ============================================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
