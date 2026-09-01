import { Link } from "react-router-dom";
import StoryCard, { storyMarkdown } from "./StoryCard";
import RubricScores from "./RubricScores";
import { ratingPillClass } from "./InterviewPrepChat";
import type { InterviewPrepSynthesis } from "../lib/types";

// Synthesis is persisted model output, so a row written by an older schema (or
// a response a field short) can be missing any of these lists.
function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

export function synthesisMarkdown(s: InterviewPrepSynthesis): string {
  const of = s.overall_feedback;
  return [
    ...(of ? [
      `## Overall (${of.rating})`,
      of.summary,
      ...(arr(of.strengths).length ? [`**Strengths:** ${arr(of.strengths).join("; ")}`] : []),
      ...(arr(of.areas_to_improve).length ? [`**Improve:** ${arr(of.areas_to_improve).join("; ")}`] : []),
      `**Readiness:** ${of.readiness}`,
      "",
    ] : []),
    "## Stories to tell",
    ...arr(s.stories).map(storyMarkdown),
    "",
    "## Competencies to focus on",
    ...arr(s.competencies).map((x) => `- **${x.name}**${x.why_it_matters ? ` — ${x.why_it_matters}` : ""}${x.evidence ? ` (evidence: ${x.evidence})` : ""}`),
    "",
    "## Questions to ask",
    ...arr(s.questions_to_ask).map((q) => `- ${q}`),
  ].join("\n");
}

/**
 * The closing sheet the rehearsal produces: how the rehearsal went, the stories
 * worth telling, the competencies to hit, and generic questions to raise.
 *
 * That last list is deliberately labelled "Questions worth raising" rather than
 * "Questions to ask" — the Game day tab has a sheet by that exact name, written
 * against the specific people in the room, and two sections with the same title
 * and different content was the page's most confusing collision.
 */
export default function PrepSummary({ synthesis }: { synthesis: InterviewPrepSynthesis }) {
  const overall = synthesis.overall_feedback;

  function copyMarkdown() {
    navigator.clipboard.writeText(synthesisMarkdown(synthesis));
  }

  return (
    <>
      {overall && (
        <div className="prep-feedback-card overall">
          <div className="prep-msg-head">
            <span className="pill">overall</span>
            <span className={`pill ${ratingPillClass(overall.rating)}`}>{overall.rating}</span>
          </div>
          <p className="small">{overall.summary}</p>
          {arr(overall.strengths).length > 0 && (
            <p className="small"><strong>Strengths:</strong> {arr(overall.strengths).join(" · ")}</p>
          )}
          {arr(overall.areas_to_improve).length > 0 && (
            <p className="small"><strong>Improve:</strong> {arr(overall.areas_to_improve).join(" · ")}</p>
          )}
          <p className="small"><strong>Readiness:</strong> {overall.readiness}</p>
          {/* Only present on syntheses generated after the coaching layer. */}
          {overall.scores && <RubricScores scores={overall.scores} />}
        </div>
      )}

      <h3 className="pp-subhead">Stories to tell</h3>
      {arr(synthesis.stories).length === 0 && <p className="muted small">None yet.</p>}
      {arr(synthesis.stories).map((s, i) => <StoryCard key={i} story={s} />)}

      <h3 className="pp-subhead">Competencies to focus on</h3>
      <ul className="clean">
        {arr(synthesis.competencies).map((c, i) => (
          <li key={i} className="small">
            <strong>{c.name}</strong>
            {c.why_it_matters && <> — {c.why_it_matters}</>}
            {c.evidence && <span className="muted"> (evidence: {c.evidence})</span>}
          </li>
        ))}
      </ul>

      {arr(synthesis.questions_to_ask).length > 0 && (
        <>
          <h3 className="pp-subhead">Questions worth raising</h3>
          <ul className="clean">
            {arr(synthesis.questions_to_ask).map((q, i) => <li key={i} className="small">{q}</li>)}
          </ul>
          <p className="muted small">
            Generic to the role. <Link to="?tab=gameday">Game day → Questions to ask</Link> writes
            them against the people actually in this room.
          </p>
        </>
      )}

      <div className="pp-foot">
        <button className="ghost sm" onClick={copyMarkdown}>Copy as markdown</button>
      </div>
    </>
  );
}
