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

// A ranked roles_to_apply entry: the posting + scoring metadata.
export type RankedRole = JobPosting & {
  organization_name: string;
  closing_soon: boolean;
  rank: number;
  priority: Priority;
};

// ── get_resume() return shape ────────────────────────────────────────────────
export interface ResumeProfile {
  success: boolean;
  resume_text: string | null;
  resume_filename: string | null;
  updated_at: string | null;
  has_resume: boolean;
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
