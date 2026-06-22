import { Link, useParams } from "react-router-dom";
import RoleFitPanel, { useRoleFit } from "../components/RoleFitPanel";
import PriorityBreakdown from "../components/PriorityBreakdown";
import TailoredResumePanel from "../components/TailoredResumePanel";
import CloseRoleControl from "../components/CloseRoleControl";
import { usePriorityWeights } from "../lib/usePriorityWeights";

// Posting-scoped fit page (reached from the to-apply table, for roles with no
// application yet). The scoring UI itself lives in RoleFitPanel, which the
// application/role view (/role/:id) also embeds.

export default function RoleFit() {
  const { id } = useParams<{ id: string }>();
  const fit = useRoleFit(id);
  const weights = usePriorityWeights();
  const { data, error, judging, judge, reload } = fit;

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const p = data.posting;
  if (!p) return <p className="error">Posting not found.</p>;

  return (
    <div className="page">
      <p><Link to="/pipeline">← Pipeline</Link></p>
      <div className="page-head">
        <h1>{p.title}</h1>
        <CloseRoleControl
          jobPostingId={p.id}
          closedAt={p.closed_at}
          closedReason={p.closed_reason}
          onChanged={reload}
        />
      </div>
      <p className="muted">
        <Link to={`/company/${p.organization_id}`}>{p.organization_name}</Link>
        {p.location ? ` · ${p.location}` : ""}
        {p.remote_policy ? ` · ${p.remote_policy}` : ""}
        {p.url && <> · <a href={p.url} target="_blank" rel="noreferrer">posting ↗</a></>}
      </p>

      <PriorityBreakdown
        inputs={p}
        weights={weights}
        judges={{
          career: data.career,
          growth: data.growth,
          onJudgeCareer: fit.judgeCareer,
          onJudgeGrowth: fit.judgeGrowth,
          judgingCareer: fit.judgingCareer,
          judgingGrowth: fit.judgingGrowth,
          error,
        }}
      />

      <RoleFitPanel data={data} judging={judging} onJudge={judge} error={error} />

      <TailoredResumePanel jobPostingId={p.id} baseResumeId={data.recommended_resume_id} />

      {(p.requirements?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Requirements</h2>
          <ul className="reqs">{p.requirements!.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
