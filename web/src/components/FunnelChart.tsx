import type { FunnelMetrics } from "../lib/types";

const STAGES = ["applied", "screening", "interviewing", "offer", "accepted"];

// The conversion funnel. Pulled out of the old standalone Funnel page so it can
// render on the Dashboard ("how's it going?" lives where you land).
export default function FunnelChart({ m }: { m: FunnelMetrics }) {
  const top = m.stage_counts[STAGES[0]] ?? 0;

  return (
    <div className="funnel">
      {STAGES.map((stage, i) => {
        const count = m.stage_counts[stage] ?? 0;
        const width = top > 0 ? Math.max((count / top) * 100, 4) : 4;
        const conv = i > 0 ? m.conversion_rates[`${STAGES[i - 1]}_to_${stage}`] : null;
        const med = m.median_days_from_applied[stage];
        return (
          <div key={stage} className="funnel-row">
            <div className="funnel-label">{stage}</div>
            <div className="funnel-bar-wrap">
              <div className="funnel-bar" style={{ width: `${width}%` }}>{count}</div>
            </div>
            <div className="funnel-meta muted">
              {conv != null && <span>{Math.round(conv * 100)}% from {STAGES[i - 1]}</span>}
              {med != null && <span> · median {med}d from applied</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
