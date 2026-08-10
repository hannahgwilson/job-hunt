import { useEffect, useState } from "react";
import { fetchStorybank, fetchScoreHistory, deleteStory, markStoryUsed, generateProgressReview } from "../lib/api";
import RubricScores from "./RubricScores";
import type { CoachingStory, ScoreHistory, CoachingScores, ProgressContent } from "../lib/types";

/**
 * The storybank and score trend — the candidate-scoped half of the coaching
 * layer (migration 024), and the reason interview prep compounds instead of
 * restarting every round.
 *
 * Distinct from the story cheat sheet: that page rolls up what each prep
 * session *generated*, grouped by employer. This is the durable inventory —
 * strength, earned secret, how recently each story was actually told.
 */
function StoryRow({ story, onChanged }: { story: CoachingStory; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  }

  const star = [story.situation, story.task, story.action, story.result].filter(Boolean);

  return (
    <div className="prep-feedback-card">
      <div className="prep-msg-head">
        <strong>{story.title}</strong>
        {story.competency && <span className="pill">{story.competency}</span>}
        {typeof story.strength === "number" && (
          <span className={`pill ${story.strength >= 4 ? "pill-accepted" : story.strength <= 2 ? "pill-warn" : ""}`}>
            strength {story.strength}/5
          </span>
        )}
      </div>

      {star.length > 0 && <p className="small">{star.join(" · ")}</p>}

      {/* A story with no earned secret is complete but interchangeable — the
          missing-secret state is the finding, so it's surfaced, not hidden. */}
      {story.earned_secret ? (
        <p className="small"><em>Earned secret:</em> {story.earned_secret}</p>
      ) : (
        <p className="muted small">
          No earned secret captured — any qualified candidate could tell this version.
        </p>
      )}

      <p className="muted small">
        {story.last_used_at
          ? `Last told ${new Date(story.last_used_at).toLocaleDateString()} · used ${story.use_count}×`
          : "Never told in a real round"}
        {story.source !== "manual" ? ` · from ${story.source}` : ""}
      </p>

      <div className="prep-chat-actions">
        <button className="ghost sm" disabled={busy} onClick={() => act(() => markStoryUsed(story.id))}>
          I told this one
        </button>
        {confirming ? (
          <>
            <button className="ghost sm" disabled={busy} onClick={() => act(() => deleteStory(story.id))}>
              Really delete
            </button>
            <button className="ghost sm" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button className="ghost sm" onClick={() => setConfirming(true)}>Delete</button>
        )}
      </div>
    </div>
  );
}

export default function StorybankPanel() {
  const [stories, setStories] = useState<CoachingStory[]>([]);
  const [history, setHistory] = useState<ScoreHistory | null>(null);
  const [progress, setProgress] = useState<ProgressContent | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchStorybank().then((r) => setStories(r.stories ?? [])).catch((e) => setError((e as Error).message));
    fetchScoreHistory(30).then(setHistory).catch((e) => setError((e as Error).message));
  }

  useEffect(load, []);

  async function runReview() {
    setReviewing(true); setError(null);
    try {
      const r = await generateProgressReview();
      setProgress((r.artifact?.content as ProgressContent) ?? null);
    } catch (e) { setError((e as Error).message); }
    finally { setReviewing(false); }
  }

  const averages = history?.averages ?? null;
  const hasScores = (history?.count ?? 0) > 0;

  return (
    <>
      <section className="card">
        <div className="section-head">
          <h2>Answer scores</h2>
          <button className="ghost sm" onClick={runReview} disabled={reviewing || !hasScores}>
            {reviewing ? "Reviewing…" : "Review my trajectory"}
          </button>
        </div>
        {error && <p className="error small">{error}</p>}

        {!hasScores && (
          <p className="muted small">
            No scored answers yet. Rehearse a mock interview and ask for feedback — each critique records a score,
            and the trend is what makes later prep sharper than the first round.
          </p>
        )}

        {hasScores && averages && (
          <>
            <p className="muted small">Average across your last {history!.count} scored answers</p>
            <RubricScores scores={averages as CoachingScores} />
            {history!.calibration_gap != null && (
              <p className="small">
                <strong>Self-assessment gap: {history!.calibration_gap > 0 ? "+" : ""}{history!.calibration_gap}</strong>{" "}
                <span className="muted">
                  {history!.calibration_gap > 0.5
                    ? "— you rate your answers above the coach's score. Closing that gap usually matters more than any single dimension."
                    : history!.calibration_gap < -0.5
                      ? "— you undersell your answers. Your read is harsher than the assessment."
                      : "— your self-assessment tracks the coach's closely."}
                </span>
              </p>
            )}
          </>
        )}

        {progress && (
          <div className="prep-feedback-card overall">
            <p className="small">{progress.trajectory}</p>
            <p className="small"><strong>Bottleneck:</strong> {progress.bottleneck}</p>
            {progress.calibration_note && <p className="muted small">{progress.calibration_note}</p>}
            {progress.storybank_health && <p className="muted small">{progress.storybank_health}</p>}
            <p className="small"><strong>Next:</strong> {progress.recommended_next}</p>
            {/* Directness 5 only. */}
            {progress.hard_truth && (
              <p className="small"><strong>Hard truth:</strong> {progress.hard_truth}</p>
            )}
            {progress.dimension_trend.length > 0 && (
              <ul className="clean">
                {progress.dimension_trend.map((d, i) => (
                  <li key={i} className="muted small">
                    {d.dimension}: {d.direction.replace(/_/g, " ")}{d.note ? ` — ${d.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Storybank</h2>
          <span className="muted small">{stories.length} {stories.length === 1 ? "story" : "stories"}</span>
        </div>
        {stories.length === 0 ? (
          <p className="muted small">
            Empty. Stories land here automatically when you generate a prep summary, or you can add them in
            conversation via the job-hunt MCP.
          </p>
        ) : (
          stories.map((s) => <StoryRow key={s.id} story={s} onChanged={load} />)
        )}
      </section>
    </>
  );
}
