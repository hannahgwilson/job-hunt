// Hand-written row shapes for the columns the UI reads. For a generated,
// exhaustive set run `supabase gen types typescript` against the live DB once
// it's deployed; these cover what the five pages touch.

export type ApplicationStatus =
  | "draft" | "applied" | "screening" | "interviewing"
  | "offer" | "accepted" | "rejected" | "withdrawn";

export const STATUS_ORDER: ApplicationStatus[] = [
  "draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn",
];

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

export interface RoleFit {
  alignment: number | null;  // 0..1
  summary: string | null;
  spikes: string[] | null;   // what clearly clears the bar
  gaps: string[] | null;     // what doesn't
  tweaks: ResumeTweak[] | null;
  model: string | null;
  judged_at: string | null;
}

export interface ResumeFitEntry {
  resume_id: string;
  label: string;
  variant: ResumeVariant | null;
  is_default: boolean;
  fit: RoleFit | null;       // null until the judge has run for this resume
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
}

export interface CompanyPosting {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  remote_policy: RemotePolicy | null;
  experience_alignment: number | null;
  application_status: ApplicationStatus | null; // null = still in the to-apply queue
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

// ── get_funnel_metrics() return shape ────────────────────────────────────────
export interface FunnelMetrics {
  success: boolean;
  window_days: number | null;
  sample_size: number;
  stage_counts: Record<string, number>;
  conversion_rates: Record<string, number | null>;
  median_days_from_applied: Record<string, number | null>;
}
