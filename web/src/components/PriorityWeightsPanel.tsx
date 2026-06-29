import { useEffect, useState } from "react";
import { fetchPriorityWeights, savePriorityWeights } from "../lib/api";
import { WEIGHTS } from "../lib/priority";
import type { PriorityComponents } from "../lib/types";

// The adjustable force-ranking levers, edited on the Pipeline page. Each slider
// is a 0–100 "points" knob; the displayed % is its share of the total (the
// server normalizes to sum 1.0 on save, so the sliders never have to add up
// exactly). Saving re-ranks the roles_to_apply queue — onSaved reloads it.
//
// Source of truth for the algorithm + defaults: semantic/metrics/priority_score.yaml.

const ROWS: Array<{ key: keyof PriorityComponents; label: string; hint: string }> = [
  { key: "experience", label: "Experience fit", hint: "JD vs your resume (AI-judged)" },
  { key: "career", label: "Career move", hint: "step up / lateral / step back" },
  { key: "location", label: "Location", hint: "hybrid-NYC > remote > onsite" },
  { key: "comp", label: "Comp", hint: "salary midpoint vs your band" },
  { key: "growth", label: "Company growth", hint: "funding / momentum stage" },
];

function pct(v: number, total: number): string {
  return total > 0 ? `${Math.round((v / total) * 100)}%` : "—";
}

export default function PriorityWeightsPanel({ onSaved }: { onSaved?: () => void }) {
  // Slider values as percentage points (0..100), seeded from saved weights ×100.
  const [vals, setVals] = useState<PriorityComponents | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function seed(w: PriorityComponents) {
    setVals({
      experience: Math.round(w.experience * 100),
      location: Math.round(w.location * 100),
      comp: Math.round(w.comp * 100),
      career: Math.round(w.career * 100),
      growth: Math.round(w.growth * 100),
    });
  }

  useEffect(() => {
    fetchPriorityWeights()
      .then((r) => { seed(r.weights); setIsCustom(r.is_custom); })
      .catch((e) => setError(e.message));
  }, []);

  if (!vals) {
    return error ? <p className="error small">{error}</p> : null;
  }

  const total = vals.experience + vals.location + vals.comp + vals.career + vals.growth;

  function set(key: keyof PriorityComponents, v: number) {
    setVals((prev) => (prev ? { ...prev, [key]: v } : prev));
    setDirty(true);
  }

  async function save() {
    if (!vals) return;
    setBusy(true);
    setError(null);
    try {
      const r = await savePriorityWeights(vals);
      seed(r.weights);
      setIsCustom(r.is_custom);
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    // Re-seed from the spec default constant; needs a save to persist.
    seed(WEIGHTS);
    setDirty(true);
  }

  return (
    <details className="weights-panel">
      <summary>
        Priority weights
        <span className={`pill ${isCustom ? "pill-warn" : ""}`}>{isCustom ? "custom" : "default"}</span>
        <span className="muted small">tune what ranks roles to apply</span>
      </summary>

      <div className="weights-rows">
        {ROWS.map(({ key, label, hint }) => (
          <div className="weight-row" key={key}>
            <div className="weight-label">
              {label}
              <span className="muted small"> · {hint}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={vals[key]}
              onChange={(e) => set(key, Number(e.target.value))}
            />
            <span className="weight-pct">{pct(vals[key], total)}</span>
          </div>
        ))}
      </div>

      <div className="weights-actions">
        <button className="sm" disabled={busy || !dirty || total <= 0} onClick={save}>
          {busy ? "Saving…" : "Save & re-rank"}
        </button>
        <button className="ghost sm" disabled={busy} onClick={reset}>Reset to default</button>
        {error && <span className="error small">{error}</span>}
        <span className="muted small">shares shown — normalized to 100% on save</span>
      </div>
    </details>
  );
}
