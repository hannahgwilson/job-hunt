import { RUBRIC_DIMENSIONS } from "../lib/types";
import type { CoachingScores } from "../lib/types";

const LABEL: Record<keyof CoachingScores, string> = {
  substance: "Substance",
  structure: "Structure",
  relevance: "Relevance",
  credibility: "Credibility",
  differentiation: "Differentiation",
};

const BLURB: Record<keyof CoachingScores, string> = {
  substance: "Evidence quality and depth",
  structure: "Narrative clarity — where STAR completeness lands",
  relevance: "Did it answer the question actually asked",
  credibility: "Believability; is your own contribution clear",
  differentiation: "Could any qualified candidate have given this answer",
};

/**
 * The five-dimension rubric, scored 1-5 (migration 024).
 *
 * Rendered as bars rather than numbers because the useful read is the *shape* —
 * one short bar among four tall ones is the bottleneck, and that's the thing to
 * work on. `bottleneck` is called out explicitly since the lowest bar and the
 * coach's chosen bottleneck can differ when two dimensions tie.
 */
export default function RubricScores({
  scores,
  bottleneck,
  compact = false,
}: {
  scores: CoachingScores;
  bottleneck?: keyof CoachingScores;
  compact?: boolean;
}) {
  return (
    <div className={`rubric-scores${compact ? " compact" : ""}`}>
      {RUBRIC_DIMENSIONS.map((dim) => {
        const value = scores[dim];
        if (typeof value !== "number") return null;
        const isBottleneck = bottleneck === dim;
        return (
          <div key={dim} className={`rubric-row${isBottleneck ? " bottleneck" : ""}`} title={BLURB[dim]}>
            <span className="rubric-label small">{LABEL[dim]}</span>
            <span className="rubric-bar" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`rubric-pip${n <= value ? " filled" : ""}`} />
              ))}
            </span>
            <span className="rubric-value small">
              {value}<span className="muted">/5</span>
            </span>
          </div>
        );
      })}
      {bottleneck && (
        <p className="muted small rubric-bottleneck">
          Bottleneck: <strong>{LABEL[bottleneck]}</strong> — fix this first.
        </p>
      )}
    </div>
  );
}
