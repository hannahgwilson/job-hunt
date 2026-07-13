import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchCompany } from "../lib/api";
import FindHiringManager from "../components/FindHiringManager";
import type { CompanyData } from "../lib/types";

// Company page: the employer, my connections there, and every role I have queued
// at it. Linked to from the role fit page and the pipeline.

export default function Company() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CompanyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchCompany(id).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const org = data.organization;
  if (!org) return <p className="error">Company not found.</p>;

  return (
    <div className="page">
      <p><Link to="/pipeline">← Pipeline</Link></p>
      <div className="page-head">
        <h1>{org.name}</h1>
        <div className="company-links">
          {org.website_url && <a href={org.website_url} target="_blank" rel="noreferrer">Website ↗</a>}
          {org.culture_url && <a href={org.culture_url} target="_blank" rel="noreferrer">Culture ↗</a>}
        </div>
      </div>
      <p className="muted">
        {org.industry ?? ""}
        {org.tags?.length ? <> · {org.tags.map((t) => <span key={t} className="pill">{t}</span>)}</> : null}
      </p>

      {org.description && (
        <section className="card"><p>{org.description}</p></section>
      )}

      <div className="cols">
        <section className="card">
          <h2>Connections <span className="count">{data.connections.length}</span></h2>
          {data.connections.length === 0 && <p className="muted">No connections logged here yet.</p>}
          {data.connections.map((c) => (
            <div key={c.id} className="connection">
              <strong>{c.name}</strong>
              {c.title && <span className="muted"> · {c.title}</span>}
              {c.linkedin_url && (
                <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="small"> profile ↗</a>
              )}
              {c.tags?.includes("job-hunt") && <span className="pill">job-hunt</span>}
              {c.tags?.includes("prospect") && <span className="pill">prospect</span>}
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Roles here <span className="count">{data.postings.length}</span></h2>
          {data.postings.length === 0 && <p className="muted">No roles queued here.</p>}
          {data.postings.map((p) => (
            <div key={p.id} className="company-role">
              <Link to={`/posting/${p.id}`}>{p.title}</Link>
              <div className="muted small">
                {[p.location, p.remote_policy].filter(Boolean).join(" · ") || "—"}
                {p.application_status
                  ? <span className={`pill pill-${p.application_status}`}>{p.application_status}</span>
                  : <span className="pill">to apply</span>}
              </div>
              {p.upcoming_interview && (
                <div className="muted small">
                  Interview: {p.upcoming_interview.interview_type ?? "interview"} · {new Date(p.upcoming_interview.scheduled_at).toLocaleString()}
                  {" · "}<Link to={`/interview-prep/${p.upcoming_interview.id}`}>Full prep →</Link>
                </div>
              )}
            </div>
          ))}
        </section>
      </div>

      <FindHiringManager organizationId={org.id} organizationName={org.name} />
    </div>
  );
}
