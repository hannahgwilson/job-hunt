import { useState } from "react";
import { runJudge } from "./api";

// Runs the AI judge over a list of jobs sequentially (one at a time, to avoid
// hammering the model API) with live progress. Each job is one posting, optionally
// scoped to a single resume. Failures are counted, not fatal — the run continues.

export interface JudgeJob {
  jobPostingId: string;
  resumeId?: string;
}

export function useBatchJudge() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState(0);

  async function run(jobs: JudgeJob[], onEach?: () => void) {
    if (jobs.length === 0) return;
    setRunning(true);
    setTotal(jobs.length);
    setDone(0);
    setErrors(0);
    for (const job of jobs) {
      try {
        await runJudge(job.jobPostingId, job.resumeId);
      } catch {
        setErrors((e) => e + 1);
      } finally {
        setDone((d) => d + 1);
        onEach?.();
      }
    }
    setRunning(false);
  }

  return { run, running, done, total, errors };
}
