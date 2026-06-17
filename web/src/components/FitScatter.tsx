import { useMemo } from "react";
import type { RoleAnalytics } from "../lib/types";

// fit-vs-(career+growth) scatter. X = resume fit (experience component), Y = the
// career-move + company-growth signals combined, bubble size = comp midpoint,
// label = location. All three signal values are the compute_priority components
// (0..1, neutral 0.5 when a judge hasn't run), so un-judged roles cluster at the
// center until the backfill fills them in — judged roles are drawn solid, the
// rest faded so you can see what still needs judging. Hand-rolled SVG, no deps.

const W = 680, H = 460;
const PAD = { l: 64, r: 20, t: 20, b: 56 };
const x0 = PAD.l, x1 = W - PAD.r, y0 = H - PAD.b, y1 = PAD.t;

const fx = (v: number) => x0 + v * (x1 - x0);
const fy = (v: number) => y0 - v * (y0 - y1);

function compMid(r: RoleAnalytics): number | null {
  if (r.salary_min == null && r.salary_max == null) return null;
  return ((r.salary_min ?? r.salary_max!) + (r.salary_max ?? r.salary_min!)) / 2;
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];

export default function FitScatter({ roles }: { roles: RoleAnalytics[] }) {
  const points = useMemo(() => {
    const comps = roles.map(compMid).filter((c): c is number => c != null);
    const minC = comps.length ? Math.min(...comps) : 0;
    const maxC = comps.length ? Math.max(...comps) : 0;
    const radius = (c: number | null): number => {
      if (c == null) return 6;
      if (maxC === minC) return 11;
      return 7 + ((c - minC) / (maxC - minC)) * 15; // 7..22px
    };
    return roles.map((r) => {
      const fit = r.priority.components.experience;
      const move = (r.priority.components.career + r.priority.components.growth) / 2;
      const judged = r.has_fit && r.has_career && r.has_growth;
      return {
        r,
        cx: fx(fit),
        cy: fy(move),
        radius: radius(compMid(r)),
        judged,
        comp: compMid(r),
      };
    });
  }, [roles]);

  if (roles.length === 0) return <p className="muted small">No roles yet.</p>;

  return (
    <div className="scatter-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="Fit vs career+growth scatter">
        {/* quadrant wash: top-right (strong fit + strong move) is the sweet spot */}
        <rect x={fx(0.5)} y={y1} width={fx(1) - fx(0.5)} height={fy(0.5) - y1} className="scatter-sweet" />

        {/* gridlines + ticks */}
        {TICKS.map((t) => (
          <g key={`gx${t}`}>
            <line x1={fx(t)} y1={y0} x2={fx(t)} y2={y1} className="scatter-grid" />
            <text x={fx(t)} y={y0 + 18} className="scatter-tick" textAnchor="middle">{t}</text>
          </g>
        ))}
        {TICKS.map((t) => (
          <g key={`gy${t}`}>
            <line x1={x0} y1={fy(t)} x2={x1} y2={fy(t)} className="scatter-grid" />
            <text x={x0 - 10} y={fy(t) + 4} className="scatter-tick" textAnchor="end">{t}</text>
          </g>
        ))}

        {/* axis titles */}
        <text x={(x0 + x1) / 2} y={H - 8} className="scatter-axis" textAnchor="middle">
          Resume fit (experience) →
        </text>
        <text x={16} y={(y0 + y1) / 2} className="scatter-axis" textAnchor="middle"
              transform={`rotate(-90 16 ${(y0 + y1) / 2})`}>
          Career move + company growth →
        </text>

        {/* bubbles */}
        {points.map((p) => (
          <g key={p.r.posting_id} className={`scatter-pt${p.judged ? "" : " unjudged"}`}>
            <circle cx={p.cx} cy={p.cy} r={p.radius}>
              <title>
                {`${p.r.title} · ${p.r.organization_name}\n`}
                {`fit ${Math.round(p.r.priority.components.experience * 100)}% · `}
                {`career ${p.r.career_trajectory ?? "—"} · growth ${p.r.growth_stage ?? "—"}\n`}
                {`comp ${p.comp != null ? `$${Math.round(p.comp / 1000)}k` : "—"}`}
                {p.judged ? "" : "\n(signals not fully judged — neutral 0.5)"}
              </title>
            </circle>
            {p.r.location && (
              <text x={p.cx} y={p.cy - p.radius - 3} className="scatter-label" textAnchor="middle">
                {p.r.location.length > 18 ? p.r.location.slice(0, 17) + "…" : p.r.location}
              </text>
            )}
          </g>
        ))}
      </svg>

      <div className="scatter-legend muted small">
        <span>● bubble size = comp</span>
        <span>· faded = signals not fully judged</span>
        <span>· top-right = strong fit + strong move</span>
      </div>
    </div>
  );
}
