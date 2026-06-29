// The app's entire data layer. Reads are RLS-scoped supabase-js selects + the
// two read RPCs; writes are the three write RPCs. Same functions the MCP wraps —
// no logic is reimplemented here.

import { supabase } from "./supabase";
import type {
  Application, ActionQueue, FunnelMetrics, Interview, StatusHistoryRow,
  CareerTrajectory, GrowthStage, ResumeProfile, Resume, ResumeVariant, RoleFitResponse,
  CompanyData, FitCoveragePosting, ResumeFeedbackResponse, CareerProfile, RoleAnalytics,
  PriorityComponents, PriorityWeightsResponse,
  ResumeBullet, BulletSection, BulletSource, AssembledResume, FeedbackTheme,
  ApplicationStatus, ClosedReason, ClosedRole, RejectedApplication,
} from "./types";

export async function fetchApplications(): Promise<Application[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, status, applied_date, response_date, notes,
      job_postings:job_posting_id (
        id, title, url, location, remote_policy, salary_min, salary_max, closing_date,
        closed_at, closed_reason,
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
        closed_at, closed_reason,
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

// Every posting with its judged signals, priority components, comp + location,
// and per-signal "judged yet?" flags. Powers the Insights scatter + signal backfill.
export async function fetchRolesAnalytics(): Promise<RoleAnalytics[]> {
  const { data, error } = await supabase.rpc("get_roles_analytics", {});
  if (error) throw error;
  return (data as { roles: RoleAnalytics[] }).roles ?? [];
}

// ── priority weights (the adjustable force-ranking levers; migration 009) ─────

export async function fetchPriorityWeights(): Promise<PriorityWeightsResponse> {
  const { data, error } = await supabase.rpc("get_priority_weights", {});
  if (error) throw error;
  return data as PriorityWeightsResponse;
}

// Persist the five levers. The RPC normalizes them to sum 1.0, so the sliders can
// move freely; returns the fresh (normalized) weights.
export async function savePriorityWeights(w: PriorityComponents): Promise<PriorityWeightsResponse> {
  const { data, error } = await supabase.rpc("save_priority_weights", {
    p_experience: w.experience,
    p_location: w.location,
    p_comp: w.comp,
    p_career: w.career,
    p_growth: w.growth,
  });
  if (error) throw error;
  return data as PriorityWeightsResponse;
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

// supabase-js throws a FunctionsHttpError on ANY non-2xx from an Edge Function,
// whose .message is just "Edge Function returned a non-2xx status code". The real
// reason is in the response body our functions return as { success:false, error }.
// Pull it out (and also handle functions that report failure with a 200 body) so
// the UI shows something actionable instead of the opaque generic message.
async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    const res = (error as { context?: Response }).context;
    if (res && typeof res.json === "function") {
      try {
        const parsed = await res.json();
        if (parsed?.error) detail = parsed.error;
      } catch {
        /* body wasn't JSON — keep the generic message */
      }
    }
    throw new Error(detail);
  }
  if ((data as { success?: boolean })?.success === false) {
    throw new Error((data as { error?: string }).error ?? `${name} failed`);
  }
  return data as T;
}

// Run the AI judge for a posting. Scores every resume vs the JD, or just one
// when resumeId is given (used to score a newly added resume against a subset of
// roles). Writes role_fit and lifts the posting's experience_alignment.
// Implemented by the judge-fit edge function — see supabase/functions/judge-fit.
export async function runJudge(jobPostingId: string, resumeId?: string): Promise<RoleFitResponse> {
  return invokeFunction<RoleFitResponse>("judge-fit", {
    job_posting_id: jobPostingId,
    resume_id: resumeId ?? null,
  });
}

// Judge the career move (step_up/lateral/step_back) for a posting against the
// user's career_profile. Writes career_judgment + lifts career_trajectory.
// Implemented by the judge-career edge function. Returns the fresh get_role_fit.
export async function runCareerJudge(jobPostingId: string): Promise<RoleFitResponse> {
  return invokeFunction<RoleFitResponse>("judge-career", { job_posting_id: jobPostingId });
}

// Judge the company's growth stage via web search. Caches signals on the org and
// writes growth_stage to every one of the company's postings. judge-growth.
export async function runGrowthJudge(jobPostingId: string): Promise<RoleFitResponse> {
  return invokeFunction<RoleFitResponse>("judge-growth", { job_posting_id: jobPostingId });
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
  return invokeFunction<ResumeFeedbackResponse>("synthesize-feedback", { resume_id: resumeId });
}

// Persist a hand-reorder (and any text edits) of a resume's synthesis themes
// without re-running the judge. Flags the synthesis manual_order so the panel
// keeps this order instead of re-sorting by the model's priority.
export async function saveSynthesisOrder(resumeId: string, themes: FeedbackTheme[]): Promise<void> {
  const { error } = await supabase.rpc("save_synthesis_order", {
    p_resume_id: resumeId,
    p_themes: themes,
  });
  if (error) throw error;
}

// ── bullet library (buildable resume; migration 010) ─────────────────────────

export async function listBullets(): Promise<ResumeBullet[]> {
  const { data, error } = await supabase.rpc("list_bullets", {});
  if (error) throw error;
  return (data as { bullets: ResumeBullet[] }).bullets ?? [];
}

export async function upsertBullet(input: {
  id?: string;
  section: BulletSection;
  text: string;
  org_label?: string | null;
  tags?: string[];
  sort_order?: number;
  is_active?: boolean;
  source?: BulletSource;
}): Promise<{ id: string }> {
  const { data, error } = await supabase.rpc("upsert_bullet", {
    p_section: input.section,
    p_text: input.text,
    p_org_label: input.org_label ?? null,
    p_tags: input.tags ?? [],
    p_sort_order: input.sort_order ?? null,
    p_is_active: input.is_active ?? true,
    p_source: input.source ?? "manual",
    p_id: input.id ?? null,
  });
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

export async function deleteBullet(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_bullet", { p_id: id });
  if (error) throw error;
}

export async function reorderBullets(ids: string[]): Promise<void> {
  const { error } = await supabase.rpc("reorder_bullets", { p_ids: ids });
  if (error) throw error;
}

// ── JD-targeted assembly (the one-page generator) ────────────────────────────

export async function getAssembledResume(jobPostingId: string): Promise<AssembledResume | null> {
  const { data, error } = await supabase.rpc("get_assembled_resume", {
    p_job_posting_id: jobPostingId,
  });
  if (error) throw error;
  return (data as { assembled: AssembledResume | null }).assembled ?? null;
}

// Run the assemble-resume judge: AI-selects + orders the best library bullets for
// this JD and drafts a tailored one-pager. Implemented by the assemble-resume
// edge function. Returns the fresh get_assembled_resume payload.
export async function assembleResume(
  jobPostingId: string,
  baseResumeId?: string,
): Promise<{ success: boolean; assembled: AssembledResume | null }> {
  return invokeFunction("assemble-resume", {
    job_posting_id: jobPostingId,
    base_resume_id: baseResumeId ?? null,
  });
}

// Save a hand-edited assembled one-pager (the user tweaks the AI draft).
export async function saveAssembledResume(input: {
  job_posting_id: string;
  body_md: string;
  base_resume_id?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("save_assembled_resume", {
    p_job_posting_id: input.job_posting_id,
    p_body_md: input.body_md,
    p_selected_bullet_ids: null,
    p_rationale: null,
    p_base_resume_id: input.base_resume_id ?? null,
    p_model: null,
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

// Close out a role (filled / pulled / not pursuing). Works whether or not I've
// applied; a live application cascades to the terminal 'closed' status.
export async function closeRole(jobPostingId: string, reason: ClosedReason = "filled"): Promise<void> {
  const { error } = await supabase.rpc("close_role", {
    p_job_posting_id: jobPostingId,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function reopenRole(jobPostingId: string): Promise<void> {
  const { error } = await supabase.rpc("reopen_role", { p_job_posting_id: jobPostingId });
  if (error) throw error;
}

// Closed/filled roles for the Pipeline "show closed" toggle — posting + org +
// (if I'd applied) the application's now-closed status, newest-closed first.
export async function fetchClosedRoles(): Promise<ClosedRole[]> {
  const { data, error } = await supabase
    .from("job_postings")
    .select("id, title, url, closed_at, closed_reason, organizations!inner(name), applications(id, status)")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false });
  if (error) throw error;
  type Raw = {
    id: string; title: string; url: string | null;
    closed_at: string | null; closed_reason: ClosedReason | null;
    organizations: { name: string } | { name: string }[] | null;
    applications: Array<{ id: string; status: ApplicationStatus }> | null;
  };
  return ((data ?? []) as unknown as Raw[]).map((p) => ({
    id: p.id,
    title: p.title,
    url: p.url,
    closed_at: p.closed_at,
    closed_reason: p.closed_reason,
    organization_name: Array.isArray(p.organizations)
      ? p.organizations[0]?.name ?? "" : p.organizations?.name ?? "",
    application_id: p.applications?.[0]?.id ?? null,
  }));
}

// Rejected / withdrawn applications for the Pipeline's "Rejected applications"
// area. A record view, not a metric, so it's computed here from base tables (no
// SQL function): we pull the terminal-negative apps with their embedded status
// history + posting, then derive the stage they died at and the dwell from the
// history — the last transition into rejected/withdrawn is the verdict, and the
// gap to the transition before it is how long I'd sat in that stage.
const TERMINAL_NEG: ApplicationStatus[] = ["rejected", "withdrawn"];

export async function fetchRejectedApplications(): Promise<RejectedApplication[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(`
      id, status, applied_date,
      job_postings:job_posting_id (
        title, url, experience_alignment,
        organizations:organization_id ( name )
      ),
      application_status_history ( from_status, to_status, changed_at ),
      interviews ( id )
    `)
    .in("status", TERMINAL_NEG);
  if (error) throw error;

  type Org = { name: string };
  type Posting = {
    title: string; url: string | null; experience_alignment: number | null;
    organizations: Org | Org[] | null;
  };
  type Hist = { from_status: string | null; to_status: string; changed_at: string };
  type Raw = {
    id: string; status: ApplicationStatus; applied_date: string | null;
    job_postings: Posting | Posting[] | null;
    application_status_history: Hist[] | null;
    interviews: Array<{ id: string }> | null;
  };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const DAY = 86_400_000;

  const rows = ((data ?? []) as unknown as Raw[]).map((a): RejectedApplication => {
    const posting = one(a.job_postings);
    const org = one(posting?.organizations ?? null);
    const hist = [...(a.application_status_history ?? [])].sort(
      (x, y) => +new Date(x.changed_at) - +new Date(y.changed_at),
    );
    // the LAST transition into a terminal-negative status = the verdict
    let endIdx = -1;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (TERMINAL_NEG.includes(hist[i].to_status as ApplicationStatus)) { endIdx = i; break; }
    }
    const end = endIdx >= 0 ? hist[endIdx] : null;
    const prev = endIdx > 0 ? hist[endIdx - 1] : null;
    const rejectedAt = end?.changed_at ?? null;

    const daysInStage = end && prev
      ? Math.round((+new Date(end.changed_at) - +new Date(prev.changed_at)) / DAY)
      : null;
    const daysInPipeline = rejectedAt && a.applied_date
      ? Math.round((+new Date(rejectedAt) - +new Date(a.applied_date)) / DAY)
      : null;

    return {
      application_id: a.id,
      status: a.status,
      title: posting?.title ?? "Untitled role",
      organization_name: org?.name ?? "",
      url: posting?.url ?? null,
      stage_rejected_at: end?.from_status ?? null,
      rejected_at: rejectedAt,
      days_in_stage: daysInStage,
      days_in_pipeline: daysInPipeline,
      fit_score: posting?.experience_alignment ?? null,
      interviews: a.interviews?.length ?? 0,
    };
  });

  // newest verdict first
  return rows.sort((x, y) => +new Date(y.rejected_at ?? 0) - +new Date(x.rejected_at ?? 0));
}
