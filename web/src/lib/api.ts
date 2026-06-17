// The app's entire data layer. Reads are RLS-scoped supabase-js selects + the
// two read RPCs; writes are the three write RPCs. Same functions the MCP wraps —
// no logic is reimplemented here.

import { supabase } from "./supabase";
import type {
  Application, ActionQueue, FunnelMetrics, Interview, StatusHistoryRow,
  CareerTrajectory, GrowthStage, ResumeProfile, Resume, ResumeVariant, RoleFitResponse,
  CompanyData, FitCoveragePosting, ResumeFeedbackResponse, CareerProfile,
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

// Company view: the org, my connections there, and every role I have queued at
// it. Plain RLS-scoped selects (no RPC needed) — same pattern as fetchApplications.
export async function fetchCompany(orgId: string): Promise<CompanyData> {
  const { data: organization, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name, industry, description, website_url, culture_url, tags")
    .eq("id", orgId)
    .single();
  if (orgErr) throw orgErr;

  const { data: connections, error: cErr } = await supabase
    .from("contacts")
    .select("id, name, title, tags")
    .eq("organization_id", orgId);
  if (cErr) throw cErr;

  const { data: postings, error: pErr } = await supabase
    .from("job_postings")
    .select("id, title, url, location, remote_policy, experience_alignment, applications:applications(id, status)")
    .eq("organization_id", orgId);
  if (pErr) throw pErr;

  type RawPosting = {
    id: string; title: string; url: string | null; location: string | null;
    remote_policy: CompanyData["postings"][number]["remote_policy"];
    experience_alignment: number | null;
    applications: Array<{ id: string; status: CompanyData["postings"][number]["application_status"] }> | null;
  };

  return {
    organization: organization as unknown as CompanyData["organization"],
    connections: (connections ?? []) as CompanyData["connections"],
    postings: ((postings ?? []) as unknown as RawPosting[]).map((p) => ({
      id: p.id, title: p.title, url: p.url, location: p.location,
      remote_policy: p.remote_policy, experience_alignment: p.experience_alignment,
      application_status: p.applications?.[0]?.status ?? null,
    })),
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

// ── resume variants ──────────────────────────────────────────────────────────

export async function listResumes(): Promise<Resume[]> {
  const { data, error } = await supabase.rpc("list_resumes", {});
  if (error) throw error;
  return (data as { resumes: Resume[] }).resumes ?? [];
}

export async function upsertResumeVariant(input: {
  label: string;
  resume_text: string;
  variant?: ResumeVariant;
  resume_filename?: string;
  id?: string;
  is_default?: boolean;
}): Promise<{ id: string }> {
  const { data, error } = await supabase.rpc("upsert_resume_variant", {
    p_label: input.label,
    p_resume_text: input.resume_text,
    p_variant: input.variant ?? "other",
    p_resume_filename: input.resume_filename ?? null,
    p_id: input.id ?? null,
    p_is_default: input.is_default ?? null,
  });
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

export async function setDefaultResume(id: string): Promise<void> {
  const { error } = await supabase.rpc("set_default_resume", { p_id: id });
  if (error) throw error;
}

export async function deleteResume(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_resume", { p_id: id });
  if (error) throw error;
}

// ── role fit (the AI-judge read of each resume vs a posting) ─────────────────

export async function getRoleFit(jobPostingId: string): Promise<RoleFitResponse> {
  const { data, error } = await supabase.rpc("get_role_fit", {
    p_job_posting_id: jobPostingId,
  });
  if (error) throw error;
  return data as RoleFitResponse;
}

// Run the AI judge for a posting. Scores every resume vs the JD, or just one
// when resumeId is given (used to score a newly added resume against a subset of
// roles). Writes role_fit and lifts the posting's experience_alignment.
// Implemented by the judge-fit edge function — see supabase/functions/judge-fit.
export async function runJudge(jobPostingId: string, resumeId?: string): Promise<RoleFitResponse> {
  const { data, error } = await supabase.functions.invoke("judge-fit", {
    body: { job_posting_id: jobPostingId, resume_id: resumeId ?? null },
  });
  if (error) throw error;
  return data as RoleFitResponse;
}

// Judge the career move (step_up/lateral/step_back) for a posting against the
// user's career_profile. Writes career_judgment + lifts career_trajectory.
// Implemented by the judge-career edge function. Returns the fresh get_role_fit.
export async function runCareerJudge(jobPostingId: string): Promise<RoleFitResponse> {
  const { data, error } = await supabase.functions.invoke("judge-career", {
    body: { job_posting_id: jobPostingId },
  });
  if (error) throw error;
  return data as RoleFitResponse;
}

// Judge the company's growth stage via web search. Caches signals on the org and
// writes growth_stage to every one of the company's postings. judge-growth.
export async function runGrowthJudge(jobPostingId: string): Promise<RoleFitResponse> {
  const { data, error } = await supabase.functions.invoke("judge-growth", {
    body: { job_posting_id: jobPostingId },
  });
  if (error) throw error;
  return data as RoleFitResponse;
}

// The career profile (baseline + ambition) judge-career reads. Edited on Profile.
export async function getCareerProfile(): Promise<{ has_profile: boolean; profile: CareerProfile | null }> {
  const { data, error } = await supabase.rpc("get_career_profile", {});
  if (error) throw error;
  const d = data as { has_profile: boolean; profile: CareerProfile | null };
  return { has_profile: d.has_profile, profile: d.profile };
}

export async function saveCareerProfile(p: CareerProfile): Promise<void> {
  const { error } = await supabase.rpc("save_career_profile", {
    p_current_title: p.current_title,
    p_current_level: p.current_level,
    p_current_track: p.current_track,
    p_current_span: p.current_span,
    p_years_experience: p.years_experience,
    p_current_comp: p.current_comp,
    p_primary_domain: p.primary_domain,
    p_target_track: p.target_track,
    p_target_level: p.target_level,
    p_target_comp_floor: p.target_comp_floor,
    p_forward_means: p.forward_means,
    p_lateral_domains: p.lateral_domains,
    p_notes: p.notes,
  });
  if (error) throw error;
}

// Fit coverage: every posting + which resume_ids have already been judged
// against it. Drives the backfill button and per-resume targeting.
export async function fetchFitCoverage(): Promise<FitCoveragePosting[]> {
  const { data, error } = await supabase.rpc("get_fit_coverage", {});
  if (error) throw error;
  return (data as { postings: FitCoveragePosting[] }).postings ?? [];
}

// Every judge read for one resume, rolled up across all roles it's been scored
// against. Powers the Resumes-tab feedback digest (the inverse of getRoleFit).
export async function fetchResumeFeedback(resumeId: string): Promise<ResumeFeedbackResponse> {
  const { data, error } = await supabase.rpc("get_resume_feedback", {
    p_resume_id: resumeId,
  });
  if (error) throw error;
  return data as ResumeFeedbackResponse;
}

// Run the synthesis judge for a resume: clusters every role's tweaks into ranked
// themes and caches them (save_resume_synthesis). Returns the fresh feedback
// payload (roles + synthesis). Implemented by the synthesize-feedback edge function.
export async function synthesizeFeedback(resumeId: string): Promise<ResumeFeedbackResponse> {
  const { data, error } = await supabase.functions.invoke("synthesize-feedback", {
    body: { resume_id: resumeId },
  });
  if (error) throw error;
  return data as ResumeFeedbackResponse;
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
