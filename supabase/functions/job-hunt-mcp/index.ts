/**
 * Extension 6: Job Hunt Pipeline MCP Server
 *
 * Layers job-hunt facts (postings, applications, interviews) on top of the
 * canonical dims:
 *   * organizations  — target employers (via organizations-mcp)
 *   * contacts       — recruiters / hiring managers / interviewers (via CRM)
 *   * events         — optional calendar surfacing for scheduled interviews
 *
 * What changed from v1.0:
 *   - No `add_company`. Use organizations-mcp `org_find_or_create`.
 *   - No `add_job_contact`. Use professional-crm `crm_add_contact` with
 *     tags=['professional','job-hunt'] and the org's id as organization_id.
 *   - No `link_contact_to_professional_crm`. They're already in CRM.
 *   - `submit_application` takes `referral_contact_id` (UUID), not text.
 *   - `schedule_interview` takes `interviewer_contact_id` (UUID), and can
 *     optionally write through to the `events` table for calendar surfacing.
 *   - `update_application_status` — explicit transition with notes; the
 *     application_status_history table is auto-populated by a DB trigger.
 *
 * What changed in v2.1 (logic-in-SQL, shared by the app):
 *   - The read aggregations (`get_funnel_metrics`) and multi-step writes
 *     (`intake_role`, `submit_application`, `update_application_status`) are
 *     thin wrappers over SQL functions in functions.sql, so the React tracking
 *     hub can call the EXACT same logic directly via supabase-js `.rpc(...)`.
 *   - `intake_role` replaces `add_job_posting`: it find-or-creates the org by
 *     NAME and inserts the posting in one transaction (no separate org call).
 *   - New `get_action_queue` — roles-to-apply / follow-ups / interviews /
 *     networking in one call.
 *   - `log_interview_notes` now records the go/no-go `advance_decision`.
 *   - Service-role calls pass `p_user_id` explicitly (RLS is bypassed).
 *
 * What changed in v2.2 (prioritization framework + semantic layer):
 *   - `intake_role` accepts three prioritization signals (experience_alignment,
 *     career_trajectory, growth_stage); new `set_priority_signals` updates them.
 *   - New `get_prioritized_roles` and `get_action_queue.roles_to_apply` are
 *     force-ranked by `compute_priority()` (the scoring algorithm in
 *     functions.sql). Metric specs live in semantic/*.yaml.
 *
 * What changed in v2.3 (resume input for the matching algo):
 *   - `get_resume` / `set_resume` read & write the default resume variant (the
 *     `resumes` dim; superseded the legacy single-row job_search_profile). Read
 *     it before judging experience_alignment. The tracking hub uploads it from
 *     the Resume page.
 *
 * What changed in v2.4 (prioritizable action checklist):
 *   - Task tools over the canonical `tasks` dim (domain='job-hunt'): `add_task`,
 *     `list_tasks`, `complete_task`, `prioritize_task`, plus the live inbox
 *     (`get_suggestions` / `promote_suggestion` / `dismiss_suggestion`) that
 *     pulls job-search thoughts + CRM follow-ups + top roles.
 *
 * What changed in v2.5 (module-scoped setup):
 *   - Env loading, the Supabase client, and all tool registrations now happen
 *     once at cold start instead of being rebuilt on every request — matches
 *     the pattern in open-brain-mcp. Auth + the Accept-header patch (the only
 *     genuinely per-request work) moved to supabase/functions/_shared/mcp-request.ts.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized, ok, patchAcceptHeader, requireEnv } from "../_shared/mcp-request.ts";

const app = new Hono();

const applicationStatusEnum = z.enum([
  "draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn", "closed",
]);
const closedReasonEnum = z.enum([
  "filled", "expired", "removed", "no_longer_interested", "other",
]);
const interviewTypeEnum = z.enum([
  "phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final",
]);
const remotePolicyEnum = z.enum(["remote", "hybrid", "onsite"]);
const sourceEnum = z.enum(["linkedin", "company-site", "referral", "recruiter", "other"]);
// Prioritization signals (see semantic/metrics/priority_score.yaml).
const careerTrajectoryEnum = z.enum(["step_up", "lateral", "step_back"]);
const growthStageEnum = z.enum(["seed", "early", "growth", "late", "public", "unknown"]);
// Action-checklist priority tiers (canonical tasks dim; see OB1 schemas/tasks).
const taskPriorityEnum = z.enum(["asap", "high", "normal", "low"]);

// ──────────────────────────────────────────────────────────────────────────────
// Module-scope setup — read once at cold start, reused across every request.
// ──────────────────────────────────────────────────────────────────────────────

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const userId = requireEnv("DEFAULT_USER_ID");

// ──────────────────────────────────────────────────────────────────────────────
// Handlers — pulled out for the multi-step writes (schedule_interview,
// get_pipeline_overview, get_funnel_metrics) where inline gets ugly.
// ──────────────────────────────────────────────────────────────────────────────

interface ScheduleInterviewArgs {
  application_id: string;
  interview_type: z.infer<typeof interviewTypeEnum>;
  scheduled_at?: string;
  duration_minutes?: number;
  interviewer_contact_id?: string;
  notes?: string;
  add_to_calendar?: boolean;
}

async function handleScheduleInterview(
  supabase: SupabaseClient,
  userId: string,
  args: ScheduleInterviewArgs,
): Promise<Record<string, unknown>> {
  let eventId: string | null = null;

  // Optional calendar bridge: create a one-off event so the interview shows
  // up in the family-calendar week view.
  if (args.add_to_calendar && args.scheduled_at) {
    // Derive a title for the event by joining out to the application + posting + org.
    const { data: applicationCtx } = await supabase
      .from("applications")
      .select(`
        id,
        job_postings!inner (
          title,
          organizations!inner ( name )
        )
      `)
      .eq("id", args.application_id)
      .eq("user_id", userId)
      .maybeSingle();

    const postingTitle =
      (applicationCtx?.job_postings as { title?: string } | undefined)?.title ?? "Interview";
    const orgName =
      (
        (applicationCtx?.job_postings as { organizations?: { name?: string } } | undefined)
          ?.organizations as { name?: string } | undefined
      )?.name ?? "";

    const dt = new Date(args.scheduled_at);
    if (Number.isNaN(dt.getTime())) {
      throw new Error("schedule_interview: scheduled_at is not a valid ISO timestamp");
    }
    const startDate = dt.toISOString().slice(0, 10); // YYYY-MM-DD
    const startTime = dt.toISOString().slice(11, 19); // HH:MM:SS
    let endTime: string | null = null;
    if (args.duration_minutes && args.duration_minutes > 0) {
      const endDt = new Date(dt.getTime() + args.duration_minutes * 60_000);
      endTime = endDt.toISOString().slice(11, 19);
    }

    const eventTitle = orgName
      ? `Interview: ${postingTitle} @ ${orgName}`
      : `Interview: ${postingTitle}`;

    const { data: eventRow, error: eventErr } = await supabase
      .from("events")
      .insert({
        user_id: userId,
        contact_id: args.interviewer_contact_id ?? null,
        title: eventTitle,
        activity_type: "interview",
        cadence_type: "once",
        start_date: startDate,
        start_time: startTime,
        end_time: endTime,
        notes: args.notes ?? null,
      })
      .select("id")
      .single();

    if (eventErr) {
      throw new Error(`schedule_interview: failed to create calendar event: ${eventErr.message}`);
    }
    eventId = eventRow?.id ?? null;
  }

  const { data, error } = await supabase
    .from("interviews")
    .insert({
      user_id: userId,
      application_id: args.application_id,
      interviewer_contact_id: args.interviewer_contact_id ?? null,
      event_id: eventId,
      interview_type: args.interview_type,
      scheduled_at: args.scheduled_at ?? null,
      duration_minutes: args.duration_minutes ?? null,
      status: "scheduled",
      notes: args.notes ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`schedule_interview failed: ${error.message}`);
  return { success: true, interview: data, calendar_event_id: eventId };
}

async function handleGetPipelineOverview(
  supabase: SupabaseClient,
  userId: string,
  daysAhead: number,
): Promise<Record<string, unknown>> {
  const { data: applications, error: appError } = await supabase
    .from("applications")
    .select("status")
    .eq("user_id", userId);
  if (appError) throw new Error(`pipeline_overview: ${appError.message}`);

  const statusCounts: Record<string, number> = {};
  for (const a of applications ?? []) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
  }

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const { data: upcoming, error: intError } = await supabase
    .from("interviews")
    .select(`
      *,
      applications!inner (
        id,
        job_postings!inner (
          id, title,
          organizations!inner ( id, name )
        )
      )
    `)
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .lte("scheduled_at", futureDate.toISOString())
    .order("scheduled_at", { ascending: true });
  if (intError) throw new Error(`pipeline_overview: ${intError.message}`);

  return {
    success: true,
    total_applications: applications?.length ?? 0,
    status_breakdown: statusCounts,
    upcoming_interviews_count: upcoming?.length ?? 0,
    upcoming_interviews: upcoming ?? [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP server + tools — registered once at cold start.
// ──────────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "job-hunt", version: "2.5.0" });

// ───────────────────────────────────────────────────────────────────────
// intake_role  (replaces add_job_posting + a separate org_find_or_create)
// Thin wrapper over the intake_role() SQL function: find-or-create the org
// by name and insert the posting in one transaction.
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "intake_role",
  "Intake a role in one transaction: find-or-create the organization by name, then add the job posting. Returns organization_id (+ whether it was newly created) and the posting. Capture the Open Brain company/role note separately via the open-brain MCP.",
  {
    organization_name: z.string().describe("Company name; matched case-insensitively or created"),
    title: z.string().describe("Job title"),
    url: z.string().optional(),
    salary_min: z.number().optional(),
    salary_max: z.number().optional(),
    salary_currency: z.string().optional().describe("Default USD"),
    requirements: z.array(z.string()).optional(),
    nice_to_haves: z.array(z.string()).optional(),
    location: z.string().optional().describe("Posting-specific location (may differ from org HQ)"),
    remote_policy: remotePolicyEnum.optional(),
    source: sourceEnum.optional(),
    posted_date: z.string().optional().describe("YYYY-MM-DD"),
    closing_date: z.string().optional().describe("YYYY-MM-DD"),
    notes: z.string().optional(),
    experience_alignment: z.number().min(0).max(1).optional()
      .describe("0..1 fit of the role's requirements vs my resume (resume/resume.example.md). Feeds the priority score."),
    career_trajectory: careerTrajectoryEnum.optional()
      .describe("Is this role a step_up / lateral / step_back from my current level? Feeds the priority score."),
    growth_stage: growthStageEnum.optional()
      .describe("The company's stage: seed / early / growth / late / public / unknown. Feeds the priority score."),
    organization_tags: z.array(z.string()).optional().describe("Tags applied only if the org is created (default ['employer-target'])"),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("intake_role", {
      p_org_name: args.organization_name,
      p_title: args.title,
      p_url: args.url ?? null,
      p_salary_min: args.salary_min ?? null,
      p_salary_max: args.salary_max ?? null,
      p_salary_currency: args.salary_currency ?? "USD",
      p_requirements: args.requirements ?? null,
      p_nice_to_haves: args.nice_to_haves ?? null,
      p_location: args.location ?? null,
      p_remote_policy: args.remote_policy ?? null,
      p_source: args.source ?? null,
      p_posted_date: args.posted_date ?? null,
      p_closing_date: args.closing_date ?? null,
      p_notes: args.notes ?? null,
      p_experience_alignment: args.experience_alignment ?? null,
      p_career_trajectory: args.career_trajectory ?? null,
      p_growth_stage: args.growth_stage ?? null,
      p_org_tags: args.organization_tags ?? ["employer-target"],
      p_user_id: userId,
    });
    if (error) throw new Error(`intake_role failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// set_priority_signals — update the agent-judged scoring inputs after intake
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "set_priority_signals",
  "Update the prioritization signals on a posting (experience_alignment 0..1, career_trajectory, growth_stage) after re-reading the JD against my resume. Only the fields you pass are changed. Returns the recomputed priority score. See semantic/metrics/priority_score.yaml.",
  {
    job_posting_id: z.string(),
    experience_alignment: z.number().min(0).max(1).optional()
      .describe("0..1 fit vs my resume (resume/resume.example.md)"),
    career_trajectory: careerTrajectoryEnum.optional(),
    growth_stage: growthStageEnum.optional(),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("set_priority_signals", {
      p_job_posting_id: args.job_posting_id,
      p_experience_alignment: args.experience_alignment ?? null,
      p_career_trajectory: args.career_trajectory ?? null,
      p_growth_stage: args.growth_stage ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`set_priority_signals failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// close_role — mark a role filled/closed (works before OR after applying)
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "close_role",
  "Close out a role that's been filled (or pulled / no longer being pursued). 'Filled' is a property of the posting, so this works whether or not I've applied: a closed role drops out of the apply queue, follow-ups, and the analytics scatter. If I had a live application, it's moved to the terminal 'closed' status (distinct from 'rejected'/'withdrawn'). Reversible with reopen_role.",
  {
    job_posting_id: z.string(),
    reason: closedReasonEnum.optional().describe("Why it closed — default 'filled'"),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("close_role", {
      p_job_posting_id: args.job_posting_id,
      p_reason: args.reason ?? "filled",
      p_user_id: userId,
    });
    if (error) throw new Error(`close_role failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// reopen_role — undo close_role; the posting re-enters the queue
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "reopen_role",
  "Reopen a previously closed role (closed it by mistake, or it came back). Clears the posting's closed flag so it re-enters the apply queue. Any application left in 'closed' stays closed — advance it by hand if the role genuinely reopened.",
  {
    job_posting_id: z.string(),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("reopen_role", {
      p_job_posting_id: args.job_posting_id,
      p_user_id: userId,
    });
    if (error) throw new Error(`reopen_role failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_prioritized_roles — force-ranked roles-to-apply, highest score first
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_prioritized_roles",
  "Force-rank the roles I haven't applied to yet by priority score (0..100): experience-alignment, location, comp, career trajectory, and company growth stage. Returns each role with its rank, score, and component breakdown — the order I should work applications. See semantic/metrics/priority_score.yaml.",
  {
    closing_days: z.number().optional().describe("Flag postings closing within this many days (default 7)"),
    limit: z.number().optional().describe("Return only the top N (default: all)"),
  },
  async (a) => {
    const { data, error } = await supabase.rpc("get_prioritized_roles", {
      p_user_id: userId,
      p_closing_days: a.closing_days ?? 7,
      p_limit: a.limit ?? null,
    });
    if (error) throw new Error(`get_prioritized_roles failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_resume — the stored long-form resume, for scoring experience alignment
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_resume",
  "Fetch my stored long-form resume. Read this when judging a role's experience_alignment (0..1) so the score reflects my actual experience. Returns has_resume=false if I haven't uploaded one yet.",
  {},
  async () => {
    const { data, error } = await supabase.rpc("get_resume", { p_user_id: userId });
    if (error) throw new Error(`get_resume failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// set_resume — save / replace the stored resume text
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "set_resume",
  "Save or replace my long-form resume text (one per user). Usually I upload this from the tracking hub, but you can set it here too.",
  {
    resume_text: z.string().describe("The full resume text"),
    resume_filename: z.string().optional().describe("Original filename, if from a file"),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("upsert_resume", {
      p_resume_text: args.resume_text,
      p_resume_filename: args.resume_filename ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`set_resume failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// submit_application
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "submit_application",
  "Record a submitted application. If someone referred you, pass `referral_contact_id` (UUID from contacts). Status defaults to 'applied' and is auto-logged to application_status_history.",
  {
    job_posting_id: z.string(),
    referral_contact_id: z.string().optional().describe("UUID of the contact who referred you"),
    status: applicationStatusEnum.optional().describe("Default 'applied'"),
    applied_date: z.string().optional().describe("YYYY-MM-DD"),
    resume_version: z.string().optional(),
    cover_letter_notes: z.string().optional(),
    notes: z.string().optional(),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("submit_application", {
      p_job_posting_id: args.job_posting_id,
      p_referral_contact_id: args.referral_contact_id ?? null,
      p_status: args.status ?? "applied",
      p_applied_date: args.applied_date ?? null,
      p_resume_version: args.resume_version ?? null,
      p_cover_letter_notes: args.cover_letter_notes ?? null,
      p_notes: args.notes ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`submit_application failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// update_application_status
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "update_application_status",
  "Move an application to a new status. The transition is auto-recorded in application_status_history by a DB trigger — pass `notes` only to annotate the application row itself.",
  {
    application_id: z.string(),
    status: applicationStatusEnum,
    response_date: z.string().optional().describe("YYYY-MM-DD — set when receiving company response"),
    notes: z.string().optional(),
  },
  async (args) => {
    const { data, error } = await supabase.rpc("advance_application", {
      p_application_id: args.application_id,
      p_new_status: args.status,
      p_response_date: args.response_date ?? null,
      p_notes: args.notes ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`update_application_status failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// schedule_interview
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "schedule_interview",
  "Schedule an interview for an application. Pass `add_to_calendar: true` to also create a row in `events` so the interview shows in the family-calendar week view.",
  {
    application_id: z.string(),
    interview_type: interviewTypeEnum,
    scheduled_at: z.string().optional().describe("ISO 8601 timestamp"),
    duration_minutes: z.number().optional(),
    interviewer_contact_id: z.string().optional().describe("UUID of the interviewer in contacts"),
    notes: z.string().optional().describe("Pre-interview prep notes"),
    add_to_calendar: z.boolean().optional().describe("Default false. When true, also writes to `events`."),
  },
  async (args) => {
    const result = await handleScheduleInterview(supabase, userId, args);
    return ok(result);
  },
);

// ───────────────────────────────────────────────────────────────────────
// log_interview_notes
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "log_interview_notes",
  "After an interview: record feedback, a rating, and the go/no-go decision (advance | hold | withdraw | rejected). Marks the interview completed.",
  {
    interview_id: z.string(),
    feedback: z.string().optional(),
    rating: z.number().min(1).max(5).optional(),
    advance_decision: z.enum(["advance", "hold", "withdraw", "rejected"]).optional()
      .describe("Do you move forward after this round?"),
    decision_notes: z.string().optional().describe("Why you decided to advance / hold / withdraw"),
  },
  async (args) => {
    const patch: Record<string, unknown> = { status: "completed" };
    if (args.feedback !== undefined) patch.feedback = args.feedback;
    if (args.rating !== undefined) patch.rating = args.rating;
    if (args.advance_decision !== undefined) patch.advance_decision = args.advance_decision;
    if (args.decision_notes !== undefined) patch.decision_notes = args.decision_notes;

    const { data, error } = await supabase
      .from("interviews")
      .update(patch)
      .eq("id", args.interview_id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw new Error(`log_interview_notes failed: ${error.message}`);
    return ok({ success: true, interview: data });
  },
);

// ───────────────────────────────────────────────────────────────────────
// list_postings
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "list_postings",
  "List tracked job postings, optionally filtered by organization. Returns posting + organization name for context. Closed/filled roles are excluded unless include_closed is set.",
  {
    organization_id: z.string().optional(),
    include_closed: z.boolean().optional().describe("Include closed/filled roles too (default false)"),
    limit: z.number().optional().describe("Default 50"),
  },
  async ({ organization_id, include_closed, limit }) => {
    let qb = supabase
      .from("job_postings")
      .select(`*, organizations!inner ( id, name )`)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit ?? 50);
    if (organization_id) qb = qb.eq("organization_id", organization_id);
    if (!include_closed) qb = qb.is("closed_at", null);
    const { data, error } = await qb;
    if (error) throw new Error(`list_postings failed: ${error.message}`);
    return ok({ success: true, count: data.length, postings: data });
  },
);

// ───────────────────────────────────────────────────────────────────────
// list_applications
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "list_applications",
  "List applications, optionally filtered by status or organization. Returns application + posting + org for context.",
  {
    status: applicationStatusEnum.optional(),
    organization_id: z.string().optional(),
    limit: z.number().optional().describe("Default 50"),
  },
  async ({ status, organization_id, limit }) => {
    let qb = supabase
      .from("applications")
      .select(`
        *,
        job_postings!inner (
          id, title, organization_id,
          organizations!inner ( id, name )
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit ?? 50);
    if (status) qb = qb.eq("status", status);
    if (organization_id) qb = qb.eq("job_postings.organization_id", organization_id);
    const { data, error } = await qb;
    if (error) throw new Error(`list_applications failed: ${error.message}`);
    return ok({ success: true, count: data.length, applications: data });
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_pipeline_overview
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_pipeline_overview",
  "Dashboard summary: application counts by status, plus upcoming interviews in the next N days (default 7).",
  {
    days_ahead: z.number().optional(),
  },
  async ({ days_ahead }) => {
    const result = await handleGetPipelineOverview(supabase, userId, days_ahead ?? 7);
    return ok(result);
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_upcoming_interviews
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_upcoming_interviews",
  "List scheduled interviews in the next N days (default 14) with org / role context.",
  {
    days_ahead: z.number().optional(),
  },
  async ({ days_ahead }) => {
    const future = new Date();
    future.setDate(future.getDate() + (days_ahead ?? 14));

    const { data, error } = await supabase
      .from("interviews")
      .select(`
        *,
        applications!inner (
          id,
          job_postings!inner (
            id, title,
            organizations!inner ( id, name )
          )
        )
      `)
      .eq("user_id", userId)
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", future.toISOString())
      .order("scheduled_at", { ascending: true });

    if (error) throw new Error(`get_upcoming_interviews failed: ${error.message}`);
    return ok({ success: true, count: data.length, interviews: data });
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_funnel_metrics
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_funnel_metrics",
  "Compute true funnel conversion rates (applied → screening → interviewing → offer → accepted) and median days-from-applied to each stage. Uses application_status_history.",
  {
    window_days: z.number().optional().describe("If set, restrict to status changes within the last N days"),
  },
  async ({ window_days }) => {
    const { data, error } = await supabase.rpc("get_funnel_metrics", {
      p_window_days: window_days ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`get_funnel_metrics failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// get_action_queue — the search to-do list in one call (thin rpc wrapper)
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "get_action_queue",
  "The job-search to-do list in one call: roles_to_apply (tracked but not yet applied), role_followups (awaiting a response past the threshold), upcoming_interviews, and networking (job-hunt contacts gone stale). Thresholds are tunable.",
  {
    followup_days: z.number().optional().describe("Flag applications awaiting a response this many days (default 7)"),
    closing_days: z.number().optional().describe("Flag postings closing within this many days (default 7)"),
    interview_days: z.number().optional().describe("Interview look-ahead window (default 14)"),
    stale_days: z.number().optional().describe("Flag job-hunt contacts not contacted in this many days (default 14)"),
  },
  async (a) => {
    const { data, error } = await supabase.rpc("get_action_queue", {
      p_user_id: userId,
      p_followup_days: a.followup_days ?? 7,
      p_closing_days: a.closing_days ?? 7,
      p_interview_days: a.interview_days ?? 14,
      p_stale_days: a.stale_days ?? 14,
    });
    if (error) throw new Error(`get_action_queue failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ───────────────────────────────────────────────────────────────────────
// Action checklist — the prioritizable to-do layer over the canonical `tasks`
// dim (domain='job-hunt'). Generic CRUD lives in OB1 schemas/tasks; these are
// thin wrappers over the job-hunt-smart RPCs in functions.sql.
// ───────────────────────────────────────────────────────────────────────
server.tool(
  "add_task",
  "Add a to-do to the job-hunt checklist, at a priority tier (asap | high | normal | low). Pass job_posting_id to create an 'apply' task linked to that role (e.g. tag a role to apply to ASAP); otherwise it's a free-form task.",
  {
    title: z.string().optional().describe("Task title. Optional only when job_posting_id is given (a default 'Apply — <role>' is used)."),
    priority: taskPriorityEnum.optional().describe("Priority tier (default normal)"),
    due_date: z.string().optional().describe("Optional due date, YYYY-MM-DD"),
    detail: z.string().optional(),
    job_posting_id: z.string().uuid().optional().describe("Link the task to a role (creates an 'apply' task)"),
  },
  async (a) => {
    if (a.job_posting_id) {
      const { data, error } = await supabase.rpc("promote_suggestion", {
        p_suggestion_key: `posting:${a.job_posting_id}`,
        p_priority: a.priority ?? "normal",
        p_title: a.title ?? null,
        p_user_id: userId,
      });
      if (error) throw new Error(`add_task failed: ${error.message}`);
      return ok(data as Record<string, unknown>);
    }
    if (!a.title) throw new Error("add_task: title is required unless job_posting_id is given");
    const { data, error } = await supabase.rpc("task_create", {
      p_title: a.title,
      p_domain: "job-hunt",
      p_detail: a.detail ?? null,
      p_priority: a.priority ?? "normal",
      p_due_date: a.due_date ?? null,
      p_kind: "custom",
      p_source: "manual",
      p_user_id: userId,
    });
    if (error) throw new Error(`add_task failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "list_tasks",
  "The job-hunt checklist: open tasks grouped by priority tier then manual order, enriched with the linked role / interview / contact. Set include_done to also show completed/dismissed.",
  {
    include_done: z.boolean().optional(),
  },
  async (a) => {
    const { data, error } = await supabase.rpc("get_job_checklist", {
      p_user_id: userId,
      p_include_done: a.include_done ?? false,
    });
    if (error) throw new Error(`list_tasks failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "complete_task",
  "Mark a checklist task done.",
  { task_id: z.string().uuid() },
  async (a) => {
    const { data, error } = await supabase.rpc("task_update", {
      p_id: a.task_id, p_status: "done", p_user_id: userId,
    });
    if (error) throw new Error(`complete_task failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "prioritize_task",
  "Change a checklist task's priority tier (asap | high | normal | low).",
  { task_id: z.string().uuid(), priority: taskPriorityEnum },
  async (a) => {
    const { data, error } = await supabase.rpc("task_update", {
      p_id: a.task_id, p_priority: a.priority, p_user_id: userId,
    });
    if (error) throw new Error(`prioritize_task failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "get_suggestions",
  "The live SUGGESTED inbox for the checklist: job-search thoughts from Open Brain, CRM follow-ups coming due, and top unapplied roles — excluding anything already added or dismissed. Add one with promote_suggestion, hide one with dismiss_suggestion.",
  {
    followup_days: z.number().optional().describe("CRM follow-up look-ahead (default 14)"),
    role_limit: z.number().optional().describe("How many top roles to suggest (default 5)"),
  },
  async (a) => {
    const { data, error } = await supabase.rpc("get_suggestions", {
      p_user_id: userId,
      p_followup_days: a.followup_days ?? 14,
      p_role_limit: a.role_limit ?? 5,
    });
    if (error) throw new Error(`get_suggestions failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "promote_suggestion",
  "Turn an inbox suggestion into a checklist task by its key ('thought:<id>' | 'crm:<id>' | 'posting:<id>'). For a thought it also marks the Open Brain note 'promoted' so it stops re-surfacing.",
  {
    suggestion_key: z.string().describe("e.g. 'thought:<uuid>', 'crm:<contact_id>', 'posting:<job_posting_id>'"),
    priority: taskPriorityEnum.optional(),
    title: z.string().optional().describe("Override the default task title"),
  },
  async (a) => {
    const { data, error } = await supabase.rpc("promote_suggestion", {
      p_suggestion_key: a.suggestion_key,
      p_priority: a.priority ?? "normal",
      p_title: a.title ?? null,
      p_user_id: userId,
    });
    if (error) throw new Error(`promote_suggestion failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

server.tool(
  "dismiss_suggestion",
  "Hide an inbox suggestion for good, by its key (so it won't be suggested again).",
  { suggestion_key: z.string() },
  async (a) => {
    const { data, error } = await supabase.rpc("dismiss_suggestion", {
      p_suggestion_key: a.suggestion_key, p_user_id: userId,
    });
    if (error) throw new Error(`dismiss_suggestion failed: ${error.message}`);
    return ok(data as Record<string, unknown>);
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// HTTP entrypoint
// ──────────────────────────────────────────────────────────────────────────────

app.post("*", async (c) => {
  patchAcceptHeader(c);
  if (!isAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);

  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("*", (c) => c.json({ status: "ok", service: "Job Hunt Pipeline", version: "2.5.0" }));

Deno.serve(app.fetch);
