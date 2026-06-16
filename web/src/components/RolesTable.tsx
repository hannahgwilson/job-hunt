import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { STATUS_ORDER, type PostingRow } from "../lib/types";

// A sortable table of every tracked role (job_postings), with the key metadata
// off the tables plus its application status. Role-centric on purpose: roles you
// haven't applied to yet still show, with status "not applied". Click a header
// to sort; click an applied role to open it. Requirement 2c.

type SortKey =
  | "company" | "title" | "status" | "location" | "remote"
  | "salary" | "applied" | "days" | "closing";

interface Col {
  key: SortKey;
  label: string;
  align?: "num";        // right-align in the cell
  sortNumeric?: boolean; // sort as number rather than text
  value: (p: PostingRow) => string | number | null;
  render: (p: PostingRow) => React.ReactNode;
}

function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000));
}

// The application that best represents the posting's state: most recently
// applied wins. Null when the role hasn't been applied to.
function chosenApp(p: PostingRow) {
  const apps = p.applications ?? [];
  if (apps.length === 0) return null;
  return [...apps].sort((a, b) => (b.applied_date ?? "").localeCompare(a.applied_date ?? ""))[0];
}

function statusOf(p: PostingRow): string {
  return chosenApp(p)?.status ?? "not applied";
}

function salaryValue(p: PostingRow): number | null {
  return p.salary_max ?? p.salary_min ?? null;
}

function salaryText(p: PostingRow): string {
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (p.salary_min && p.salary_max) return `${k(p.salary_min)}–${k(p.salary_max)}`;
  if (p.salary_max) return `≤ ${k(p.salary_max)}`;
  if (p.salary_min) return `≥ ${k(p.salary_min)}`;
  return "—";
}

const COLS: Col[] = [
  { key: "company", label: "Company", value: (p) => p.organizations?.name ?? "", render: (p) => p.organizations?.name ?? "—" },
  { key: "title", label: "Role", value: (p) => p.title ?? "", render: (p) => p.title ?? "Untitled role" },
  {
    key: "status", label: "Status", sortNumeric: true,
    // "not applied" sorts before draft (-1); otherwise by funnel order.
    value: (p) => { const s = statusOf(p); return s === "not applied" ? -1 : STATUS_ORDER.indexOf(s as never); },
    render: (p) => { const s = statusOf(p); return <span className={s === "not applied" ? "pill pill-none" : `pill pill-${s}`}>{s}</span>; },
  },
  { key: "location", label: "Location", value: (p) => p.location ?? "", render: (p) => p.location ?? "—" },
  { key: "remote", label: "Remote", value: (p) => p.remote_policy ?? "", render: (p) => p.remote_policy ?? "—" },
  { key: "salary", label: "Salary", align: "num", sortNumeric: true, value: salaryValue, render: salaryText },
  { key: "applied", label: "Applied", value: (p) => chosenApp(p)?.applied_date ?? "", render: (p) => chosenApp(p)?.applied_date ?? "—" },
  { key: "days", label: "Days", align: "num", sortNumeric: true, value: (p) => daysSince(chosenApp(p)?.applied_date ?? null), render: (p) => { const d = daysSince(chosenApp(p)?.applied_date ?? null); return d == null ? "—" : `${d}d`; } },
  { key: "closing", label: "Closing", value: (p) => p.closing_date ?? "", render: (p) => p.closing_date ?? "—" },
];

export default function RolesTable({ postings }: { postings: PostingRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [asc, setAsc] = useState(true);
  const navigate = useNavigate();

  const col = COLS.find((c) => c.key === sortKey)!;

  const sorted = useMemo(() => {
    const rows = [...postings];
    rows.sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      const na = va == null || va === "";
      const nb = vb == null || vb === "";
      if (na && nb) return 0;
      if (na) return 1;   // blanks always sink, regardless of direction
      if (nb) return -1;
      const cmp = col.sortNumeric
        ? (va as number) - (vb as number)
        : String(va).localeCompare(String(vb));
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [postings, col, asc]);

  function toggle(key: SortKey) {
    if (key === sortKey) setAsc((p) => !p);
    else { setSortKey(key); setAsc(true); }
  }

  function open(p: PostingRow) {
    const app = chosenApp(p);
    if (app) navigate(`/role/${app.id}`);          // applied → role detail
    else if (p.url) window.open(p.url, "_blank");  // not applied → the posting
  }

  if (postings.length === 0) return <p className="muted">No roles tracked yet.</p>;

  return (
    <div className="table-wrap">
      <table className="roles-table">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.key}
                className={`${c.align === "num" ? "num" : ""} ${c.key === sortKey ? "sorted" : ""}`}
                onClick={() => toggle(c.key)}
              >
                {c.label}
                <span className="sort-caret">{c.key === sortKey ? (asc ? " ▲" : " ▼") : ""}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id} onClick={() => open(p)}>
              {COLS.map((c) => (
                <td key={c.key} className={c.align === "num" ? "num" : ""}>{c.render(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
