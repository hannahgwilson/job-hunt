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
  // The last failure's message, so the UI can show *why* a judge didn't run —
  // not just that some did. Kept as the most recent reason (the common case is
  // every job failing the same way: no API key, no resume, model error).
  const [lastError, setLastError] = useState<string | null>(null);

  async function run(jobs: JudgeJob[], onEach?: () => void) {
    if (jobs.length === 0) return;
    setRunning(true);
    setTotal(jobs.length);
    setDone(0);
    setErrors(0);
    setLastError(null);
    for (const job of jobs) {
      try {
        await runJudge(job.jobPostingId, job.resumeId);
      } catch (e) {
        setErrors((n) => n + 1);
        setLastError((e as Error).message);
      } finally {
        setDone((d) => d + 1);
        onEach?.();
      }
    }
    setRunning(false);
  }

  return { run, running, done, total, errors, lastError };
}
