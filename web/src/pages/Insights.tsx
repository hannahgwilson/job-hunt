import { useEffect, useState } from "react";
import { fetchRolesAnalytics, runCareerJudge, runGrowthJudge } from "../lib/api";
import { useBatchRunner } from "../lib/useBatchRunner";
import type { RoleAnalytics } from "../lib/types";
import FitScatter from "../components/FitScatter";

// Insights: run the career + growth judges across every un-judged role in one
// sweep, then read the result as a fit-vs-(career+growth) scatter. The two
// judges fill the priority signals compute_priority reads — see the role pages
// for the single-role versions.

export default function Insights() {
  const [roles, setRoles] = useState<RoleAnalytics[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const batch = useBatchRunner();

  function load() {
    fetchRolesAnalytics().then(setRoles).catch((e) => setError(e.message));
  }

  useEffect(() => { load(); }, []);

  // Career is per-posting; growth is per-company (one judge call updates every
  // posting at that org), so we backfill career for each un-judged posting and
  // growth once per un-judged company.
  const careerTodo = (roles ?? []).filter((r) => !r.has_career);
  const growthOrgs = new Map<string, RoleAnalytics>();
  for (const r of roles ?? []) {
    if (!r.has_growth && !growthOrgs.has(r.organization_id)) growthOrgs.set(r.organization_id, r);
  }
  const growthTodo = [...growthOrgs.values()];
  const todo = careerTodo.length + growthTodo.length;

  async function backfill() {
    setError(null);
    const tasks = [
      ...careerTodo.map((r) => () => runCareerJudge(r.posting_id)),
      ...growthTodo.map((r) => () => runGrowthJudge(r.posting_id)),
    ];
    await batch.run(tasks);
    load();
  }

  if (error) return <div className="page"><h1>Insights</h1><p className="error">{error}</p></div>;
  if (roles == null) return <div className="page"><h1>Insights</h1><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Insights</h1>
        {batch.running ? (
          <span className="muted small">
            Judging {batch.done}/{batch.total}…{batch.errors > 0 && <span className="error"> · {batch.errors} failed</span>}
          </span>
        ) : (
          <button
            disabled={todo === 0}
            onClick={backfill}
            title="Run the career-move and company-growth judges for every role that hasn't been judged"
          >
            {todo === 0
              ? "All roles judged"
              : `Judge career + growth · ${careerTodo.length} roles, ${growthTodo.length} companies`}
          </button>
        )}
      </div>

      <p className="muted small">
        Each role placed by <strong>resume fit</strong> (x) against its{" "}
        <strong>career move + company growth</strong> (y); bubble size is comp,
        the label is location. Top-right is the sweet spot. Roles whose signals
        aren't fully judged sit at the neutral center, faded — run the backfill to
        place them for real.
      </p>

      <section className="card">
        <FitScatter roles={roles} />
      </section>
    </div>
  );
}
