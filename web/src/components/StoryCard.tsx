import type { InterviewPrepStory } from "../lib/types";

// The one way a story renders, wherever it appears (Story library, the prep
// page's "Stories to tell"). Full STAR card when the fields exist; legacy
// pre-STAR-split sessions carry only the `story` blob, so fall back to that
// rather than rendering an empty card (see D6/D7 in docs/interviews-backlog.md).

export function hasStar(s: InterviewPrepStory): boolean {
  return Boolean(s.situation || s.task || s.action || s.result);
}

// Plain-text flattening for copy/markdown builders — the string twin of the
// JSX below, so copied prep sheets never interpolate `undefined` again.
export function storyMarkdown(s: InterviewPrepStory): string {
  const head = `- **${s.title}**${s.competency ? ` _[${s.competency}]_` : ""}${s.best_for ? ` _(for: ${s.best_for})_` : ""}`;
  if (!hasStar(s)) return s.story ? `${head}\n  ${s.story}` : head;
  const star = (["situation", "task", "action", "result"] as const)
    .filter((k) => s[k])
    .map((k) => `  - ${k[0].toUpperCase()}${k.slice(1)}: ${s[k]}`);
  return [head, ...star].join("\n");
}

export default function StoryCard({
  story,
  source,
  showCompetency = true,
}: {
  story: InterviewPrepStory;
  // e.g. "from Cityblock prep" — the library shows provenance, the per-round
  // prep page doesn't need to (the round IS the context).
  source?: string;
  // The library rail already groups by competency, so it hides the pill.
  showCompetency?: boolean;
}) {
  return (
    <div className="story-card">
      <div className="story-card-head">
        <div className="story-card-title">
          {story.title}
          {showCompetency && story.competency && (
            <span className="pill competency-pill">{story.competency}</span>
          )}
        </div>
        {source && <div className="muted small">{source}</div>}
      </div>
      {hasStar(story) ? (
        <dl className="story-star">
          {story.situation && <><dt>Situation</dt><dd>{story.situation}</dd></>}
          {story.task && <><dt>Task</dt><dd>{story.task}</dd></>}
          {story.action && <><dt>Action</dt><dd>{story.action}</dd></>}
          {story.result && <><dt>Result</dt><dd>{story.result}</dd></>}
        </dl>
      ) : (
        <p>{story.story}</p>
      )}
      {story.best_for && <div className="story-card-foot">Best for: {story.best_for}</div>}
    </div>
  );
}
