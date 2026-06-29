import { useEffect, useState } from "react";
import { fetchPriorityWeights } from "./api";
import { WEIGHTS } from "./priority";
import type { PriorityComponents } from "./types";

// Read-only fetch of the user's saved priority weights, for the role-page
// breakdowns so they match the Pipeline force-ranking. Falls back to the spec
// default constant until loaded (and if the read fails) — a breakdown should
// never block on it.
export function usePriorityWeights(): PriorityComponents {
  const [weights, setWeights] = useState<PriorityComponents>(WEIGHTS);
  useEffect(() => {
    fetchPriorityWeights()
      .then((r) => setWeights(r.weights))
      .catch(() => { /* keep the default */ });
  }, []);
  return weights;
}
