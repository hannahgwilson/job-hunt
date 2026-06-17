import { useState } from "react";

// Runs a list of async tasks one at a time (to avoid hammering the model API)
// with live progress. Generic over the task — the Insights page uses it to run
// the career + growth judges across many roles; failures are counted, not fatal.

export function useBatchRunner() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState(0);

  async function run(tasks: Array<() => Promise<unknown>>, onEach?: () => void) {
    if (tasks.length === 0) return;
    setRunning(true);
    setTotal(tasks.length);
    setDone(0);
    setErrors(0);
    for (const task of tasks) {
      try {
        await task();
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
