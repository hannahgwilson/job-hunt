import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);

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

  const hovered = points.find((p) => p.r.posting_id === hover) ?? null;

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

        {/* bubbles — hover for the title, click through to the pipeline */}
        {points.map((p) => (
          <g
            key={p.r.posting_id}
            className={`scatter-pt${p.judged ? "" : " unjudged"}${hover === p.r.posting_id ? " hover" : ""}`}
            onMouseEnter={() => setHover(p.r.posting_id)}
            onMouseLeave={() => setHover((h) => (h === p.r.posting_id ? null : h))}
            onClick={() => navigate(`/posting/${p.r.posting_id}`)}
          >
            <circle cx={p.cx} cy={p.cy} r={p.radius} />
            {p.r.location && (
              <text x={p.cx} y={p.cy - p.radius - 3} className="scatter-label" textAnchor="middle">
                {p.r.location.length > 18 ? p.r.location.slice(0, 17) + "…" : p.r.location}
              </text>
            )}
          </g>
        ))}

        {/* hover tooltip — drawn last so it sits on top of every bubble */}
        {hovered && (() => {
          const fitPct = Math.round(hovered.r.priority.components.experience * 100);
          const comp = hovered.comp != null ? `$${Math.round(hovered.comp / 1000)}k` : "comp —";
          const sub = `${hovered.r.organization_name} · fit ${fitPct}% · ${comp}`
            + ` · ${hovered.r.career_trajectory ?? "career —"} · ${hovered.r.growth_stage ?? "growth —"}`;
          const w = Math.min(360, Math.max(hovered.r.title.length, sub.length) * 6.3 + 18);
          const tx = Math.max(x0, Math.min(hovered.cx - w / 2, x1 - w));
          const above = hovered.cy - hovered.radius - 42 >= y1;
          const ty = above ? hovered.cy - hovered.radius - 42 : hovered.cy + hovered.radius + 8;
          return (
            <g className="scatter-tip" pointerEvents="none">
              <rect x={tx} y={ty} width={w} height={36} rx={5} />
              <text x={tx + 9} y={ty + 15} className="scatter-tip-title">
                {hovered.r.title.length > 52 ? hovered.r.title.slice(0, 51) + "…" : hovered.r.title}
              </text>
              <text x={tx + 9} y={ty + 29} className="scatter-tip-sub">
                {sub.length > 56 ? sub.slice(0, 55) + "…" : sub}
              </text>
            </g>
          );
        })()}
      </svg>

      <div className="scatter-legend muted small">
        <span>● bubble size = comp</span>
        <span>· faded = signals not fully judged</span>
        <span>· hover for the role · click to open its page</span>
      </div>
    </div>
  );
}
