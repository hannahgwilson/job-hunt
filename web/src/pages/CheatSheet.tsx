import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchStoryCheatSheet } from "../lib/api";
import type { CheatSheetSession } from "../lib/types";

// A single skim-before-you-walk-in page: every STAR story, competency, and
// question-to-ask synthesized across every interview prep session so far,
// grouped by company. Read-only rollup — the stories themselves are edited
// on the per-interview prep page (InterviewPrepPage) and land here once
// synthesized.

function matches(session: CheatSheetSession, q: string): boolean {
  if (!q) return true;
  const hay = [
    session.organization_name, session.role_title,
    ...session.stories.flatMap((s) => [s.title, s.story, s.best_for ?? ""]),
    ...session.competencies.flatMap((c) => [c.name, c.why_it_matters ?? "", c.evidence ?? ""]),
    ...session.questions_to_ask,
  ].join(" \n ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

function toMarkdown(sessions: CheatSheetSession[]): string {
  const parts: string[] = ["# Interview cheat sheet", ""];
  for (const s of sessions) {
    parts.push(`## ${s.organization_name} — ${s.role_title}`);
    if (s.stories.length > 0) {
      parts.push("", "**Stories**");
      parts.push(...s.stories.map((x) => `- **${x.title}** — ${x.story}${x.best_for ? ` _(for: ${x.best_for})_` : ""}`));
    }
    if (s.competencies.length > 0) {
      parts.push("", "**Competencies**");
      parts.push(...s.competencies.map((x) => `- **${x.name}**${x.why_it_matters ? ` — ${x.why_it_matters}` : ""}${x.evidence ? ` (evidence: ${x.evidence})` : ""}`));
    }
    if (s.questions_to_ask.length > 0) {
      parts.push("", "**Questions to ask**");
      parts.push(...s.questions_to_ask.map((q) => `- ${q}`));
    }
    parts.push("");
  }
  return parts.join("\n");
}

export default function CheatSheet() {
  const [sheet, setSheet] = useState<CheatSheetSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchStoryCheatSheet()
      .then((r) => {
        if (!r.success) setError(r.error ?? "Could not load the cheat sheet.");
        else setSheet(r.sessions);
      })
      .catch((e) => setError(e.message));
  }, []);

  const filtered = useMemo(() => (sheet ?? []).filter((s) => matches(s, query)), [sheet, query]);

  const totals = useMemo(() => {
    const stories = filtered.reduce((n, s) => n + s.stories.length, 0);
    const competencies = filtered.reduce((n, s) => n + s.competencies.length, 0);
    return { stories, competencies, companies: filtered.length };
  }, [filtered]);

  function copyAll() {
    navigator.clipboard.writeText(toMarkdown(filtered));
  }

  if (error) return <p className="error">{error}</p>;
  if (!sheet) return <p className="muted">Loading…</p>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Interview cheat sheet</h1>
        <span className="muted small">
          {totals.stories} stor{totals.stories === 1 ? "y" : "ies"} · {totals.competencies} competenc{totals.competencies === 1 ? "y" : "ies"} · {totals.companies} compan{totals.companies === 1 ? "y" : "ies"}
        </span>
      </div>

      {sheet.length === 0 ? (
        <p className="muted">
          No prepped stories yet — generate a prep summary from an interview's prep page
          (research it, rehearse, then "Generate prep summary") and it'll show up here.
        </p>
      ) : (
        <>
          <div className="section-head">
            <input
              type="search"
              placeholder="Search stories, competencies, companies…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="ghost sm" onClick={copyAll}>Copy all as markdown</button>
          </div>

          {filtered.length === 0 && <p className="muted small">No matches for "{query}".</p>}

          {filtered.map((s) => (
            <section className="card" key={s.interview_id}>
              <div className="page-head">
                <h2>
                  <Link to={`/company/${s.organization_id}`}>{s.organization_name}</Link>
                  {" — "}
                  {s.role_title}
                </h2>
                <Link to={`/interview-prep/${s.interview_id}`} className="ghost sm">
                  {s.interview_type ?? "interview"}
                  {s.scheduled_at ? ` · ${new Date(s.scheduled_at).toLocaleDateString()}` : ""}
                </Link>
              </div>

              {s.stories.length > 0 && (
                <>
                  <h3>Stories</h3>
                  <ul className="clean">
                    {s.stories.map((story, i) => (
                      <li key={i}>
                        <strong>{story.title}</strong> — {story.story}
                        {story.best_for && <span className="muted small"> (for: {story.best_for})</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {s.competencies.length > 0 && (
                <>
                  <h3>Competencies</h3>
                  <ul className="clean">
                    {s.competencies.map((c, i) => (
                      <li key={i}>
                        <strong>{c.name}</strong>
                        {c.why_it_matters && <> — {c.why_it_matters}</>}
                        {c.evidence && <span className="muted small"> (evidence: {c.evidence})</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {s.questions_to_ask.length > 0 && (
                <>
                  <h3>Questions to ask</h3>
                  <ul className="clean">
                    {s.questions_to_ask.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
