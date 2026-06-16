// The app's entire data layer. Reads are RLS-scoped supabase-js selects + the
// two read RPCs; writes are the three write RPCs. Same functions the MCP wraps —
// no logic is reimplemented here.

import { supabase } from "./supabase";
import type {
  Application, ActionQueue, FunnelMetrics, Interview, StatusHistoryRow,
  CareerTrajectory, GrowthStage, ResumeProfile,
} from "./types";

export async function fetchApplications(): Promise<Application[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, status, applied_date, response_date, notes,
      job_postings:job_posting_id (
        id, title, url, location, remote_policy, salary_min, salary_max, closing_date,
        organizations:organization_id ( id, name )
      )
    `)
    .order("applied_date", { ascending: false, nullsFirst: false });
  if (error) throw error;
  // PostgREST returns embedded to-one relations as objects; normalize.
  return (data ?? []) as unknown as Application[];
}

export async function fetchRole(applicationId: string): Promise<{
  application: Application;
  history: StatusHistoryRow[];
  interviews: Interview[];
}> {
  const { data: application, error: appErr } = await supabase
    .from("applications")
    .select(`
      id, status, applied_date, response_date, notes,
      job_postings:job_posting_id (
        id, title, url, location, remote_policy, salary_min, salary_max, closing_date,
        organizations:organization_id ( id, name )
      )
    `)
    .eq("id", applicationId)
    .single();
  if (appErr) throw appErr;

  const { data: history, error: histErr } = await supabase
    .from("application_status_history")
    .select("id, from_status, to_status, changed_at, notes")
    .eq("application_id", applicationId)
    .order("changed_at", { ascending: true });
  if (histErr) throw histErr;

  const { data: interviews, error: intErr } = await supabase
    .from("interviews")
    .select("id, interview_type, scheduled_at, status, rating, feedback, advance_decision, decision_notes")
    .eq("application_id", applicationId)
    .order("scheduled_at", { ascending: true, nullsFirst: false });
  if (intErr) throw intErr;

  return {
    application: application as unknown as Application,
    history: (history ?? []) as StatusHistoryRow[],
    interviews: (interviews ?? []) as Interview[],
  };
}

export async function fetchActionQueue(): Promise<ActionQueue> {
  const { data, error } = await supabase.rpc("get_action_queue", {});
  if (error) throw error;
  return data as ActionQueue;
}

export async function fetchFunnelMetrics(windowDays?: number): Promise<FunnelMetrics> {
  const { data, error } = await supabase.rpc("get_funnel_metrics", {
    p_window_days: windowDays ?? null,
  });
  if (error) throw error;
  return data as FunnelMetrics;
}

// ── writes ───────────────────────────────────────────────────────────────────

export interface IntakeRoleInput {
  organization_name: string;
  title: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
  location?: string;
  remote_policy?: string;
  source?: string;
  requirements?: string[];
  notes?: string;
  // prioritization signals (see semantic/metrics/priority_score.yaml)
  experience_alignment?: number; // 0..1
  career_trajectory?: CareerTrajectory;
  growth_stage?: GrowthStage;
}

export async function intakeRole(input: IntakeRoleInput): Promise<{ posting_id: string }> {
  const { data, error } = await supabase.rpc("intake_role", {
    p_org_name: input.organization_name,
    p_title: input.title,
    p_url: input.url ?? null,
    p_salary_min: input.salary_min ?? null,
    p_salary_max: input.salary_max ?? null,
    p_location: input.location ?? null,
    p_remote_policy: input.remote_policy ?? null,
    p_source: input.source ?? null,
    p_requirements: input.requirements ?? null,
    p_notes: input.notes ?? null,
    p_experience_alignment: input.experience_alignment ?? null,
    p_career_trajectory: input.career_trajectory ?? null,
    p_growth_stage: input.growth_stage ?? null,
  });
  if (error) throw error;
  const posting = (data as { posting?: { id: string } }).posting;
  return { posting_id: posting?.id ?? "" };
}

export async function setPrioritySignals(input: {
  job_posting_id: string;
  experience_alignment?: number;
  career_trajectory?: CareerTrajectory;
  growth_stage?: GrowthStage;
}): Promise<void> {
  const { error } = await supabase.rpc("set_priority_signals", {
    p_job_posting_id: input.job_posting_id,
    p_experience_alignment: input.experience_alignment ?? null,
    p_career_trajectory: input.career_trajectory ?? null,
    p_growth_stage: input.growth_stage ?? null,
  });
  if (error) throw error;
}

export async function fetchResume(): Promise<ResumeProfile> {
  const { data, error } = await supabase.rpc("get_resume", {});
  if (error) throw error;
  return data as ResumeProfile;
}

export async function saveResume(text: string, filename?: string): Promise<void> {
  const { error } = await supabase.rpc("upsert_resume", {
    p_resume_text: text,
    p_resume_filename: filename ?? null,
  });
  if (error) throw error;
}

export async function submitApplication(jobPostingId: string, appliedDate?: string): Promise<void> {
  const { error } = await supabase.rpc("submit_application", {
    p_job_posting_id: jobPostingId,
    p_applied_date: appliedDate ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw error;
}

export async function advanceApplication(
  applicationId: string,
  newStatus: string,
  notes?: string,
): Promise<void> {
  const { error } = await supabase.rpc("advance_application", {
    p_application_id: applicationId,
    p_new_status: newStatus,
    p_notes: notes ?? null,
  });
  if (error) throw error;
}
