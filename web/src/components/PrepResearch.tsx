import type { InterviewPrepResearch } from "../lib/types";

/**
 * The research stage's output: who's in the room, what the role actually is,
 * and what to focus on.
 *
 * People come first and get the most room — the rest of prep (concerns,
 * questions to ask, the mock interviewer's persona) is all downstream of who
 * you're actually meeting, and it's the part you re-read on the morning.
 */
export default function PrepResearch({ research }: { research: InterviewPrepResearch }) {
  const people = research.people ?? [];

  // No "Who you'll meet" subhead: the panel wrapping this is already titled
  // that, and the people are the first thing in it.
  return (
    <>
      {people.length === 0 ? (
        <p className="muted small">
          No named attendees found — add names to the intake notes and regenerate.
        </p>
      ) : (
        <div className="pp-people">
          {people.map((p, i) => {
            const linkedin = p.sources?.find((s) => /linkedin\.com/i.test(s));
            const otherSources = (p.sources ?? []).filter((s) => s !== linkedin);
            return (
              <div key={i} className="prep-person">
                <div className="prep-person-head">
                  <strong>{p.name}</strong>
                  {p.title && <span className="muted small"> · {p.title}</span>}
                  {p.likely_relationship && <span className="pill">{p.likely_relationship}</span>}
                </div>
                {p.background && <p className="small">{p.background}</p>}
                {p.what_they_probably_care_about && p.what_they_probably_care_about.length > 0 && (
                  <p className="muted small">Cares about: {p.what_they_probably_care_about.join(", ")}</p>
                )}
                {(linkedin || otherSources.length > 0) && (
                  <p className="muted small pp-sources">
                    {linkedin && <a href={linkedin} target="_blank" rel="noreferrer">LinkedIn ↗</a>}
                    {otherSources.map((s, j) => (
                      <a key={j} href={s} target="_blank" rel="noreferrer">
                        source{otherSources.length > 1 ? ` ${j + 1}` : ""} ↗
                      </a>
                    ))}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(research.role_summary || (research.role_functions ?? []).length > 0) && (
        <>
          <h3 className="pp-subhead">About the role</h3>
          {research.role_summary && <p className="small">{research.role_summary}</p>}
          {(research.role_functions ?? []).length > 0 && (
            <ul className="clean">
              {research.role_functions!.map((f, i) => <li key={i} className="small">{f}</li>)}
            </ul>
          )}
        </>
      )}

      {(research.prep_focus ?? []).length > 0 && (
        <div className="prep-focus">
          <h3>Focus on</h3>
          <ul className="clean">
            {research.prep_focus!.map((f, i) => <li key={i} className="small">{f}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}
