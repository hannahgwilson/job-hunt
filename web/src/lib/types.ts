// Hand-written row shapes for the columns the UI reads. For a generated,
// exhaustive set run `supabase gen types typescript` against the live DB once
// it's deployed; these cover what the five pages touch.

export type ApplicationStatus =
  | "draft" | "applied" | "screening" | "interviewing"
  | "offer" | "accepted" | "rejected" | "withdrawn" | "closed";

// Why a posting closed. 'filled' is the headline case (close_role's default).
export type ClosedReason =
  | "filled" | "expired" | "removed" | "no_longer_interested" | "duplicate" | "other";

export const CLOSED_REASON_LABELS: Record<ClosedReason, string> = {
  filled: "Filled",
  expired: "Expired / closed",
  removed: "Posting pulled",
  no_longer_interested: "Not pursuing",
  duplicate: "Duplicate",
  other: "Closed",
};

export const STATUS_ORDER: ApplicationStatus[] = [
  "draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn",
];

// The kanban columns — the forward funnel only. Terminal-negative outcomes
// (rejected / withdrawn) drop off the board into the Pipeline's "Rejected
// applications" area, the same way filled roles go to "Closed roles".
export const PIPELINE_COLUMNS: ApplicationStatus[] = [
  "applied", "screening", "interviewing", "offer", "accepted",
];

export type RemotePolicy = "remote" | "hybrid" | "onsite";
export type Source = "linkedin" | "company-site" | "referral" | "recruiter" | "other";

export interface Organization {
  id: string;
  name: string;
}

export interface JobPosting {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  remote_policy: RemotePolicy | null;
  salary_min: number | null;
  salary_max: number | null;
  closing_date: string | null;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  requirements: string[] | null;
  nice_to_haves: string[] | null;
  organizations?: Organization;
}

export interface Application {
  id: string;
  status: ApplicationStatus;
  applied_date: string | null;
  response_date: string | null;
  notes: string | null;
  job_postings?: JobPosting;
}

export interface StatusHistoryRow {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  notes: string | null;
}

export interface Interview {
  id: string;
  interview_type: string | null;
  scheduled_at: string | null;
  status: string;
  rating: number | null;
  feedback: string | null;
  advance_decision: "advance" | "hold" | "withdraw" | "rejected" | null;
  decision_notes: string | null;
}

// ── prioritization (see semantic/metrics/priority_score.yaml) ────────────────
export type CareerTrajectory = "step_up" | "lateral" | "step_back";
export type GrowthStage = "seed" | "early" | "growth" | "late" | "public" | "unknown";
// Role track judged from the JD by judge-fit (migration 011).
export type RoleType = "ic" | "manager" | "hybrid" | "unclear";

export interface PriorityComponents {
  experience: number;
  location: number;
  comp: number;
  career: number;
  growth: number;
}

export interface Priority {
  score: number;            // 0..100
  components: PriorityComponents;
  weights: PriorityComponents;
}

// get_priority_weights() — the user's adjustable priority levers (migration 009).
// is_custom = they've moved the sliders off the neutral spec default.
export interface PriorityWeightsResponse {
  success: boolean;
  is_custom: boolean;
  weights: PriorityComponents;
}

// A ranked roles_to_apply entry: the posting + scoring metadata.
export type RankedRole = JobPosting & {
  organization_name: string;
  closing_soon: boolean;
  rank: number;
  priority: Priority;
};

// ── get_roles_analytics() — the Insights signal map (scatter + backfill) ─────
// One posting with its judged signals, derived priority components, raw comp +
// location for plotting, and per-signal "judged yet?" flags.
export interface RoleAnalytics {
  posting_id: string;
  title: string;
  organization_id: string;
  organization_name: string;
  location: string | null;
  remote_policy: RemotePolicy | null;
  salary_min: number | null;
  salary_max: number | null;
  experience_alignment: number | null;
  career_trajectory: CareerTrajectory | null;
  growth_stage: GrowthStage | null;
  priority: Priority;
  application_status: ApplicationStatus | null;
  has_fit: boolean;
  has_career: boolean;
  has_growth: boolean;
}

// ── get_resume() return shape ────────────────────────────────────────────────
export interface ResumeProfile {
  success: boolean;
  resume_text: string | null;
  resume_filename: string | null;
  updated_at: string | null;
  has_resume: boolean;
}

// ── resume variants + per-role fit (see migration 004) ───────────────────────
export type ResumeVariant = "ic" | "manager" | "other";

export interface Resume {
  id: string;
  label: string;
  variant: ResumeVariant | null;
  resume_text: string | null;
  resume_filename: string | null;
  is_default: boolean;
  updated_at: string | null;
}

// One proposed resume edit from the judge — framed for both a human reader and
// an ATS / AI screen (see the judge-fit edge function).
export interface ResumeTweak {
  section: string | null;   // e.g. "Summary", "Experience → Acme"
  suggestion: string;       // the proposed change
  rationale: string | null; // why it helps against this JD
}

// One row of the judge's adjacency table — how the resume's evidence stacks up
// against a single JD requirement. The alignment score is the importance-weighted
// average of these tiers, so this is the chain-of-thought behind the number.
export type AdjacencyTier = "identical" | "adjacent" | "aware" | "gap";

export interface RequirementScore {
  requirement: string;                          // the JD requirement, in a few words
  importance: "required" | "nice_to_have";      // core vs nice-to-have (drives weighting)
  tier: AdjacencyTier;                           // identical 1.0 / adjacent 0.75 / aware 0.2 / gap 0.0
  rule: string | null;                          // rule cited for an adjacent/aware call (e.g. "R1")
  evidence: string | null;                      // the resume evidence (or its absence)
}

// The user's eval label on one judge-fit analysis (the Tuning Bench). Intel for
// tuning the prompt — distinct from the analysis (RoleFit) it rates.
export type FitRating = "good" | "bad";

export interface FitEval {
  rating: FitRating | null;   // is the judge's analysis accurate?
  is_best: boolean;           // best read for this JD among the variants
  notes: string | null;       // what the judge got wrong / should weigh
  updated_at: string | null;
}

export interface RoleFit {
  alignment: number | null;  // 0..1
  summary: string | null;
  spikes: string[] | null;   // what clearly clears the bar
  gaps: string[] | null;     // what doesn't
  tweaks: ResumeTweak[] | null;
  requirement_scores: RequirementScore[] | null; // per-requirement adjacency table
  model: string | null;
  judged_at: string | null;
}

export interface ResumeFitEntry {
  resume_id: string;
  label: string;
  variant: ResumeVariant | null;
  is_default: boolean;
  fit: RoleFit | null;       // null until the judge has run for this resume
  eval?: FitEval | null;     // the user's rating of this analysis (Tuning Bench)
}

// One rated analysis, joined with what it judged — the get_fit_evals export the
// bench hands back for prompt tuning.
export interface FitEvalRow {
  job_posting_id: string;
  title: string;
  organization_name: string;
  resume_id: string;
  resume_label: string;
  resume_variant: ResumeVariant | null;
  rating: FitRating | null;
  is_best: boolean;
  notes: string | null;
  updated_at: string | null;
  alignment: number | null;
  summary: string | null;
  requirement_scores: RequirementScore[] | null;
  model: string | null;
}

// One row per posting for the backfill / per-resume targeting UIs.
export interface FitCoveragePosting {
  id: string;
  title: string;
  organization_name: string;
  judged_resume_ids: string[]; // resumes already scored against this posting
}

// One role a resume has been judged against, with that judge's feedback —
// the per-resume roll-up returned by get_resume_feedback (Resumes-tab digest).
export interface ResumeFeedbackRole {
  posting_id: string;
  title: string;
  organization_name: string;
  alignment: number | null;  // 0..1
  summary: string | null;
  spikes: string[] | null;
  gaps: string[] | null;
  tweaks: ResumeTweak[] | null;
  requirement_scores: RequirementScore[] | null;
  model: string | null;
  judged_at: string | null;
}

// One synthesized, cross-role theme — a bucket of similar tweaks the
// synthesize-feedback judge merged and ranked (see save_resume_synthesis).
export type ThemePriority = "high" | "medium" | "low";
export type ThemeCategory =
  | "Summary" | "Experience" | "Skills & keywords" | "Structure & formatting" | "Other";

export interface FeedbackTheme {
  title: string;
  category: ThemeCategory;
  priority: ThemePriority;
  role_count: number;
  recommendation: string;
  rationale: string | null;
  roles: string[] | null;
}

// The cached synthesis for a resume (null until the judge has run).
export interface FeedbackSynthesis {
  themes: FeedbackTheme[] | null;
  headline: string | null;
  source_count: number | null;  // # of judge reads it was built from
  model: string | null;
  synthesized_at: string | null;
  manual_order?: boolean;       // true → themes kept in the user's hand-set order
}

// ── buildable resume: bullet library + JD-targeted assembly (migration 010) ───
export type BulletSection = "Summary" | "Experience" | "Skills" | "Education" | "Other";
export const BULLET_SECTIONS: BulletSection[] = ["Summary", "Experience", "Skills", "Education", "Other"];
export type BulletSource = "manual" | "synthesis" | "judge";

export interface ResumeBullet {
  id: string;
  section: BulletSection;
  org_label: string | null;
  text: string;
  tags: string[];
  sort_order: number;
  is_active: boolean;
  source: BulletSource;
  updated_at: string | null;
}

// The AI-built one-pager for a posting (null until assemble-resume runs).
export interface AssembledResume {
  job_posting_id: string;
  base_resume_id: string | null;
  body_md: string | null;
  selected_bullet_ids: string[] | null;
  rationale: string | null;
  model: string | null;
  generated_at: string | null;
}

export interface ResumeFeedbackResponse {
  success: boolean;
  resume_id: string;
  roles: ResumeFeedbackRole[];
  synthesis: FeedbackSynthesis | null;
}

// ── career-trajectory judge (see migration 006 + judge-career edge function) ──
export type DeltaDir = "up" | "flat" | "down" | "n/a";

export interface CareerJudgment {
  trajectory: CareerTrajectory | null;
  confidence: number | null;
  deltas: Partial<Record<"seniority" | "scope" | "comp" | "track" | "domain", DeltaDir>> | null;
  rationale: string | null;
  model: string | null;
  judged_at: string | null;
}

// ── growth judge (cached per-company on organizations; see judge-growth) ──────
export interface GrowthSignals {
  funding_stage?: string;
  last_round_date?: string;
  total_raised?: string;
  headcount?: string;
  headcount_trend?: string;
  momentum?: string[];
  risks?: string[];
}

export interface GrowthJudgment {
  stage: GrowthStage | null;
  confidence: number | null;
  signals: GrowthSignals | null;
  sources: string[] | null;
  rationale: string | null;
  model: string | null;
  judged_at: string | null;
}

export interface RoleFitResponse {
  success: boolean;
  posting: {
    id: string;
    title: string;
    url: string | null;
    location: string | null;
    remote_policy: RemotePolicy | null;
    salary_min: number | null;
    salary_max: number | null;
    requirements: string[] | null;
    nice_to_haves: string[] | null;
    experience_alignment: number | null;
    career_trajectory: CareerTrajectory | null;
    growth_stage: GrowthStage | null;
    role_type: RoleType | null;
    closed_at: string | null;
    closed_reason: ClosedReason | null;
    organization_id: string;
    organization_name: string;
  } | null;
  resumes: ResumeFitEntry[];
  recommended_resume_id: string | null;
  career: CareerJudgment | null;  // null until judge-career has run
  growth: GrowthJudgment | null;  // null until judge-growth has run for the company
}

// ── career profile (the personal baseline judge-career reads; migration 006) ──
export type CareerTrack = "ic" | "manager";
export type TargetTrack = "ic" | "manager" | "either";

export interface CareerProfile {
  current_title: string | null;
  current_level: string | null;
  current_track: CareerTrack | null;
  current_span: number | null;
  years_experience: number | null;
  current_comp: number | null;
  primary_domain: string | null;
  target_track: TargetTrack | null;
  target_level: string | null;
  target_comp_floor: number | null;
  forward_means: string[] | null;
  lateral_domains: string[] | null;
  notes: string | null;
}

// ── company page ─────────────────────────────────────────────────────────────
export interface CompanyConnection {
  id: string;
  name: string;
  title: string | null;
  tags: string[] | null;
  linkedin_url: string | null;
}

export interface CompanyPosting {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  remote_policy: RemotePolicy | null;
  experience_alignment: number | null;
  application_status: ApplicationStatus | null; // null = still in the to-apply queue
  upcoming_interview: { id: string; interview_type: string | null; scheduled_at: string } | null;
}

export interface CompanyData {
  organization: {
    id: string;
    name: string;
    industry: string | null;
    description: string | null;
    website_url: string | null;
    culture_url: string | null;
    tags: string[] | null;
  } | null;
  connections: CompanyConnection[];
  postings: CompanyPosting[];
}

// A closed/filled role, for the Pipeline "show closed" toggle (fetchClosedRoles).
export interface ClosedRole {
  id: string;                       // job_posting_id
  title: string;
  url: string | null;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  organization_name: string;
  application_id: string | null;    // the (now-closed) application, if I'd applied
}

// ── get_action_queue() return shape ──────────────────────────────────────────
export interface ActionQueue {
  success: boolean;
  roles_to_apply: RankedRole[];
  role_followups: Array<{
    application_id: string;
    status: ApplicationStatus;
    applied_date: string | null;
    days_waiting: number | null;
    title: string;
    organization_name: string;
    url: string | null;
  }>;
  upcoming_interviews: Array<{
    interview_id: string;
    interview_type: string | null;
    scheduled_at: string;
    title: string;
    organization_name: string;
  }>;
  networking: Array<{
    contact_id: string;
    name: string;
    title: string | null;
    last_contacted: string | null;
    organization_name: string | null;
  }>;
}

// One stage's decision-conditioned funnel counts (pass_through_rate.yaml).
export interface StagePassThrough {
  total_ever: number;
  moved_on: number;
  terminated_here: number;
  pending: number;
  rate: number | null;   // moved_on / (moved_on + terminated_here); null until a decision
}

// ── get_funnel_metrics() return shape ────────────────────────────────────────
export interface FunnelMetrics {
  success: boolean;
  window_days: number | null;
  sample_size: number;
  stage_counts: Record<string, number>;
  conversion_rates: Record<string, number | null>;
  median_days_from_applied: Record<string, number | null>;
  // pass_through_rate.yaml + days_in_stage.yaml (per forward stage)
  pass_through: Record<string, StagePassThrough>;
  median_days_in_stage: Record<string, number | null>;
}

// ── action checklist (canonical tasks dim; domain='job-hunt', migration 016) ──
export type TaskPriority = "asap" | "high" | "normal" | "low";
export type TaskStatus = "open" | "done" | "dismissed" | "snoozed";

export const TASK_TIERS: { key: TaskPriority; label: string; dot: string }[] = [
  { key: "asap", label: "ASAP", dot: "🔴" },
  { key: "high", label: "High", dot: "🟠" },
  { key: "normal", label: "Normal", dot: "⚪" },
  { key: "low", label: "Low", dot: "🔵" },
];

export interface Task {
  id: string;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  sort_order: number;
  due_date: string | null;
  kind: string | null;
  source: string;
  thought_id: string | null;
  job_posting_id: string | null;
  application_id: string | null;
  interview_id: string | null;
  contact_id: string | null;
  completed_at: string | null;
  created_at: string;
  // enrichment joined by get_job_checklist (null when the link is absent):
  organization_name?: string | null;
  role_title?: string | null;
  role_url?: string | null;
  interview_type?: string | null;
  interview_at?: string | null;
  contact_name?: string | null;
}

export interface JobChecklist { success: boolean; tasks: Task[]; }

// ── live suggestion inbox (get_suggestions) ──────────────────────────────────
export interface ThoughtSuggestion {
  key: string; kind: "thought"; thought_type: string | null;
  content: string; created_at: string;
}
export interface FollowupSuggestion {
  key: string; kind: "followup"; contact_id: string; name: string;
  title: string | null; organization_name: string | null;
  follow_up_date: string | null; overdue: boolean;
}
export interface RoleSuggestion {
  key: string; kind: "apply"; job_posting_id: string; title: string;
  organization_name: string | null; score: string | null; rank: string;
}
export interface Suggestions {
  success: boolean;
  open_brain: ThoughtSuggestion[];
  followups: FollowupSuggestion[];
  roles: RoleSuggestion[];
}

// ── interview prep (static assembly; get_interview_prep) ──────────────────────
export interface InterviewPrep {
  success: boolean;
  error?: string;
  interview: { id: string; interview_type: string | null; scheduled_at: string | null; status: string };
  role: { job_posting_id: string; title: string; organization_id: string; organization_name: string };
  company_intel: {
    growth_stage: string | null;
    growth_signals: GrowthSignals | null;
    growth_rationale: string | null;
    notes: Array<{ content: string; created_at: string }>;
  };
  fit: { alignment: number | null; summary: string | null; spikes: string[] | null; gaps: string[] | null; resume_label: string | null } | null;
  interviewer: { contact_id: string; name: string; title: string | null; last_contacted: string | null } | null;
  prep_tasks: Task[];
}

// ── interview prep session (round two — get_interview_prep_session) ──────────
// The full AI-written prep flow: intake -> research -> mock-interview chat ->
// closing synthesis. Distinct from the static `InterviewPrep` card above.
export interface InterviewPrepPerson {
  name: string;
  title?: string;
  likely_relationship?: string;
  background?: string;
  what_they_probably_care_about?: string[];
  sources?: string[];
}

export interface InterviewPrepResearch {
  role_summary?: string;
  role_functions?: string[];
  people?: InterviewPrepPerson[];
  prep_focus?: string[];
}

export type InterviewPrepMessageKind = "interviewer" | "user" | "coach_feedback";

export interface InterviewPrepMessage {
  id: string;
  kind: InterviewPrepMessageKind;
  content: string;          // for kind='coach_feedback', a JSON-encoded InterviewPrepFeedback
  in_reply_to?: string;
  created_at: string;
}

export interface InterviewPrepFeedback {
  rating: "strong" | "solid" | "needs_work" | "weak";
  what_worked: string[];
  what_to_improve: string[];
  suggested_rewrite?: string;
}

// Workshop mode — critiquing a draft before it's sent. Ephemeral: nothing is
// persisted, so this is a plain result object, not a fresh InterviewPrepSession.
export interface InterviewPrepDraftFeedback {
  success: boolean;
  error?: string;
  feedback?: InterviewPrepFeedback;
  question?: string | null;
}

export interface InterviewPrepStory {
  title: string;
  story: string;
  best_for?: string;
}

export interface InterviewPrepCompetency {
  name: string;
  why_it_matters?: string;
  evidence?: string;
}

export interface InterviewPrepSynthesis {
  stories: InterviewPrepStory[];
  competencies: InterviewPrepCompetency[];
  questions_to_ask: string[];
}

export interface InterviewPrepSessionRow {
  intake_notes: string | null;
  source_thought_id: string | null;
  research: InterviewPrepResearch | null;
  research_model: string | null;
  research_generated_at: string | null;
  transcript: InterviewPrepMessage[];
  synthesis: InterviewPrepSynthesis | null;
  synthesis_model: string | null;
  synthesized_at: string | null;
}

export interface InterviewPrepSession {
  success: boolean;
  error?: string;
  interview: { id: string; interview_type: string | null; scheduled_at: string | null; status: string };
  role: { application_id: string; job_posting_id: string; title: string; organization_id: string; organization_name: string };
  company_intel: { growth_stage: string | null };
  fit: { alignment: number | null; summary: string | null; spikes: string[] | null; gaps: string[] | null } | null;
  interviewer: { contact_id: string; name: string; title: string | null } | null;
  ob_suggestions: Array<{ thought_id: string; content: string; created_at: string }>;
  session: InterviewPrepSessionRow | null;
}

// One rejected/withdrawn application for the Pipeline "Rejected" area. Computed
// client-side (fetchRejectedApplications) from status history — not a metric, so
// it lives outside the semantic catalog (like the Closed-roles list).
export interface RejectedApplication {
  application_id: string;
  status: ApplicationStatus;          // 'rejected' | 'withdrawn'
  title: string;
  organization_name: string;
  url: string | null;
  stage_rejected_at: string | null;   // the stage I was in when it ended
  rejected_at: string | null;
  days_in_stage: number | null;       // dwell in that final stage
  days_in_pipeline: number | null;    // applied → rejected
  fit_score: number | null;           // posting.experience_alignment (0..1)
  interviews: number;                 // interviews logged before the no
}
