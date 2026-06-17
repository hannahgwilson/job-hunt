import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PriorityComponents, RankedRole } from "../lib/types";

// Sortable "roles to apply" table — the force-ranked top-of-funnel. Click a
// column header to re-sort ("move them around"); default is priority high→low.

type SortKey = "score" | "title" | "company" | "location" | "comp" | "closing";
type Dir = "asc" | "desc";

const COMPONENT_LABELS: Array<[keyof PriorityComponents, string]> = [
  ["experience", "Fit vs resume"],
  ["location", "Location"],
  ["comp", "Comp"],
  ["career", "Career"],
  ["growth", "Growth"],
];

function scoreClass(s: number): string {
  if (s >= 70) return "score-high";
  if (s >= 45) return "score-mid";
  return "score-low";
}

function comp(r: RankedRole): number {
  const lo = r.salary_min ?? r.salary_max;
  const hi = r.salary_max ?? r.salary_min;
  return lo && hi ? (lo + hi) / 2 : -1;
}

function compLabel(r: RankedRole): string {
  if (!r.salary_min && !r.salary_max) return "—";
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (r.salary_min && r.salary_max) return `${k(r.salary_min)}–${k(r.salary_max)}`;
  return k((r.salary_min ?? r.salary_max)!);
}

function locationLabel(r: RankedRole): string {
  const parts = [r.location, r.remote_policy].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

function FitBars({ c }: { c: PriorityComponents }) {
  return (
    <span className="fit-bars" title={COMPONENT_LABELS.map(([k, l]) => `${l}: ${c[k]}`).join("\n")}>
      {COMPONENT_LABELS.map(([k]) => (
        <span key={k} className="fit-bar"><span style={{ height: `${c[k] * 100}%` }} /></span>
      ))}
    </span>
  );
}

export default function RolesToApplyTable({
  roles, onApply, applyingId, highlightId,
}: {
  roles: RankedRole[];
  onApply?: (postingId: string) => void;
  applyingId?: string | null;
  highlightId?: string | null; // posting id to scroll to + flag (e.g. from the Insights scatter)
}) {
  const [sort, setSort] = useState<SortKey>("score");
  const [dir, setDir] = useState<Dir>("desc");
  const highlightRow = useRef<HTMLTableRowElement>(null);

  // When arriving with ?role=… scroll that row into view and let it pulse.
  useEffect(() => {
    if (highlightId && highlightRow.current) {
      highlightRow.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, roles]);

  function clickSort(key: SortKey) {
    if (key === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(key); setDir(key === "title" || key === "company" ? "asc" : "desc"); }
  }

  const sorted = [...roles].sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "score": cmp = a.priority.score - b.priority.score; break;
      case "title": cmp = (a.title ?? "").localeCompare(b.title ?? ""); break;
      case "company": cmp = a.organization_name.localeCompare(b.organization_name); break;
      case "location": cmp = locationLabel(a).localeCompare(locationLabel(b)); break;
      case "comp": cmp = comp(a) - comp(b); break;
      case "closing":
        cmp = (a.closing_date ?? "9999").localeCompare(b.closing_date ?? "9999"); break;
    }
    return dir === "asc" ? cmp : -cmp;
  });

  function Th({ k, label, num }: { k: SortKey; label: string; num?: boolean }) {
    return (
      <th className={`sortable${num ? " num" : ""}`} onClick={() => clickSort(k)}>
        {label}{sort === k && <span className="arrow">{dir === "asc" ? "▲" : "▼"}</span>}
      </th>
    );
  }

  if (roles.length === 0) return <p className="muted">Nothing waiting to apply to.</p>;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <Th k="score" label="Priority" />
            <th>Fit</th>
            <Th k="title" label="Role" />
            <Th k="company" label="Company" />
            <Th k="location" label="Location" />
            <Th k="comp" label="Comp" num />
            <Th k="closing" label="Closing" />
            {onApply && <th></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.id}
              ref={r.id === highlightId ? highlightRow : undefined}
              className={r.id === highlightId ? "row-highlight" : undefined}
            >
              <td>
                <span className={`score-badge ${scoreClass(r.priority.score)}`}>{r.priority.score}</span>
              </td>
              <td><FitBars c={r.priority.components} /></td>
              <td className="role-title">
                <Link to={`/posting/${r.id}`}>{r.title}</Link>
                {r.url && (
                  <a className="ext" href={r.url} target="_blank" rel="noreferrer" title="Open posting">↗</a>
                )}
              </td>
              <td>{r.organization_name}</td>
              <td>{locationLabel(r)}</td>
              <td className="num">{compLabel(r)}</td>
              <td>
                {r.closing_date ?? "—"}
                {r.closing_soon && <span className="pill pill-warn">soon</span>}
              </td>
              {onApply && (
                <td>
                  <button className="ghost sm" disabled={applyingId === r.id} onClick={() => onApply(r.id)}>
                    {applyingId === r.id ? "…" : "Mark applied"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
