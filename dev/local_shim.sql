-- Local-only shim: the pieces the deployed database provides that this repo
-- does NOT own, stubbed just far enough that schema.sql / migrations /
-- functions.sql will load and run against a throwaway Postgres.
--
-- This exists to close the gap that has bitten this repo twice: SQL can only be
-- applied to the deployed database by hand, so a migration's first real
-- execution used to be in production ("the frontend shipped; the schema
-- didn't" — see docs/interviews-backlog.md § Schema state). With this you can
-- prove a migration parses, applies, and returns what you expect before pasting
-- it into the Supabase SQL editor.
--
-- Run it with dev/local_db.sh. NEVER apply this to the deployed database:
-- these tables are owned by the organizations / contacts / family-calendar /
-- Open Brain schemas, and these definitions are approximations of them — only
-- the columns this repo actually reads, with no RLS and no constraints.

-- ── Supabase's auth surface ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);

-- Stands in for the JWT-backed auth.uid(). Set it per session with
--   SELECT set_config('jh.uid', '<uuid>', false);
-- so RLS-shaped functions can be exercised as a given user.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $fn$ SELECT nullif(current_setting('jh.uid', true), '')::uuid $fn$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Supabase ships this trigger helper; schema.sql attaches triggers to it.
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger
LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;

-- The roles GRANT statements target.
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── shared dims (schemas/organizations, extensions/family-calendar) ──────────
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  name text NOT NULL, industry text, description text, website_url text,
  culture_url text, tags text[] DEFAULT '{}',
  -- cached per-company growth judgment (migration 006 adds these on the real dim)
  growth_stage text, growth_confidence numeric, growth_signals jsonb,
  growth_sources jsonb, growth_rationale text, growth_model text,
  growth_judged_at timestamptz
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  name text NOT NULL, title text, tags text[] DEFAULT '{}',
  linkedin_url text, organization_id uuid REFERENCES organizations(id),
  last_contacted date, follow_up_date date
);

-- Only the interview-to-calendar bridge touches this.
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  title text, starts_at timestamptz, ends_at timestamptz, kind text
);

-- ── Open Brain ───────────────────────────────────────────────────────────────
-- Note the shape D8 is about: no owner column. Reproduced faithfully, because
-- the leak is a property of this table's design, not of the readers.
CREATE TABLE IF NOT EXISTS thoughts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content text,
  metadata jsonb DEFAULT '{}', status text, created_at timestamptz DEFAULT now()
);

-- ── canonical tasks dim (domain='job-hunt' rows are this repo's checklist) ────
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  domain text, title text NOT NULL, detail text, status text DEFAULT 'open',
  priority text DEFAULT 'normal', sort_order int DEFAULT 0, due_date date,
  kind text, source text DEFAULT 'manual', thought_id uuid,
  job_posting_id uuid, application_id uuid, interview_id uuid, contact_id uuid,
  completed_at timestamptz, ended_at timestamptz, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  domain text, suggestion_key text, created_at timestamptz DEFAULT now()
);
