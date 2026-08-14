import { useEffect, useMemo, useState } from "react";
import {
  applyStoryCluster, assembleStoryCluster, consolidateStories, deleteStory, fetchStorybank,
  markStoryUsed, mergeStories, setStoryAnchors,
} from "../lib/api";
import type { CoachingStory, StoryCluster, StoryConsolidationProposal } from "../lib/types";

/**
 * The story library — one library, reading the durable storybank.
 *
 * There used to be two. This tab rendered get_story_cheat_sheet, a rollup over
 * interview_prep_sessions.synthesis: derived, regenerated on every read, and
 * grouped by employer. Meanwhile coaching_stories — the table built to be the
 * durable inventory — sat empty. The consequence wasn't cosmetic: each prep
 * session invented its own title for a story it had already been told, so the
 * same Garner steerage work existed under four names, none of them accumulating
 * a strength score, an earned secret, or a use count.
 *
 * So: the storybank is the library, and `Consolidate` is the bridge — it reads
 * every telling out of every past synthesis and folds them into one entry each.
 * The per-round view of "what did this session generate" still lives on the prep
 * page, where the round is the context and that framing is the right one.
 */

// The candidate's own names for the stories she keeps coming back to. Anchors
// are what stop the library drifting back to model-invented titles: consolidation
// files variants INTO them and never merges one away.
const ANCHOR_PLACEHOLDER = [
  "Steerage dashboard at Oscar",
  "Managing out a team member at Oscar",
  "Reconfiguring the team at Garner",
  "AI rollout at Garner",
  "High Cost Member Dashboard at Oscar",
  "Shadow reporting at Oscar for actuarial reporting",
  "KPI migration at Garner",
  "Hiring at Garner & growing Noah / Tamas",
  "MedEcon $24m at Oscar",
  "Behavioral health fraud investigation",
  "Talent Dashboard at Garner",
].join("\n");

function strengthClass(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 4 ? "pill-accepted" : n <= 2 ? "pill-warn" : "";
}

/**
 * `aliases` arrives from migration 026. A storybank row read before that
 * migration is applied has no such column, and reading `.length` off the
 * undefined would throw through the render and blank the app — the exact failure
 * mode 092ad18 fixed for prep artifacts. Read it through here.
 */
function aliasesOf(s: CoachingStory): string[] {
  return Array.isArray(s.aliases) ? s.aliases : [];
}

/** One library entry. Read-first: the actions are secondary to the STAR text,
 *  because this gets opened to rehearse, not to administer. */
function LibraryStory({
  story, onChanged, onPickMerge, mergeSelected, mergeMode,
}: {
  story: CoachingStory;
  onChanged: () => void;
  onPickMerge: (id: string) => void;
  mergeSelected: boolean;
  mergeMode: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  }

  const star: Array<[string, string | null]> = [
    ["Situation", story.situation], ["Task", story.task],
    ["Action", story.action], ["Result", story.result],
  ];
  const written = star.some(([, v]) => v);
  const aliases = aliasesOf(story);

  return (
    <div className={`story-card${mergeSelected ? " is-picked" : ""}`}>
      <div className="story-card-head">
        <div className="story-card-title">
          {mergeMode && (
            <input
              type="checkbox"
              checked={mergeSelected}
              onChange={() => onPickMerge(story.id)}
              aria-label={`Select "${story.title}" to merge`}
            />
          )}
          {story.title}
          {story.is_anchor && <span className="pill" title="One of the stories you named yourself">anchor</span>}
          {story.company && <span className="pill">{story.company}</span>}
          {story.strength != null && (
            <span className={`pill ${strengthClass(story.strength)}`}>strength {story.strength}/5</span>
          )}
        </div>
        <div className="muted small">
          {story.last_used_at
            ? `told ${new Date(story.last_used_at).toLocaleDateString()} · ${story.use_count}×`
            : "never told"}
        </div>
      </div>

      {/* An anchor with no STAR is a real finding, not an empty card: it's a
          story she says she tells and has never written down. */}
      {!written ? (
        <p className="muted small">
          {story.is_anchor
            ? "Nothing written down yet — this is a story you say you tell but the library has no version of. Rehearse a round it fits, or dictate it in conversation."
            : "No STAR written."}
        </p>
      ) : (
        <dl className="story-star">
          {star.map(([k, v]) => v && <><dt key={k}>{k}</dt><dd key={`${k}d`}>{v}</dd></>)}
        </dl>
      )}

      {/* Missing secret and missing number are different problems, and both are
          more useful surfaced than tidied away. */}
      {written && !story.earned_secret && (
        <p className="muted small">
          No earned secret — any qualified candidate could tell this version.
        </p>
      )}
      {story.earned_secret && <p className="small"><em>Earned secret:</em> {story.earned_secret}</p>}
      {story.sharpen && <p className="small story-sharpen"><strong>Sharpen:</strong> {story.sharpen}</p>}
      {story.best_for && <div className="story-card-foot">Best for: {story.best_for}</div>}

      {aliases.length > 0 && (
        <p className="muted small">
          <button className="linklike" onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} absorbed {aliases.length} earlier title{aliases.length === 1 ? "" : "s"}
          </button>
          {open && <span> — {aliases.join(" · ")}</span>}
        </p>
      )}

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

/**
 * Where a proposed cluster is in the two-pass flow.
 *
 * The plan pass returns identity only — title, variant titles, anchor match —
 * and each story is then assembled by its own request. So a card exists, with
 * its real name on it, before it has any words in it.
 */
type ClusterStatus = "queued" | "assembling" | "ready" | "applying" | "done" | "skipped" | "error";

const STATUS_NOTE: Partial<Record<ClusterStatus, string>> = {
  queued: "waiting to assemble",
  assembling: "assembling from every telling…",
  applying: "saving…",
  done: "saved",
  skipped: "skipped",
  error: "couldn't assemble",
};

/**
 * The consolidation proposal, per cluster, accept or skip.
 *
 * Deliberately not auto-applied. Every other AI stage in this app writes
 * directly, because a bad artifact just gets regenerated — but a merge destroys
 * material. If four tellings of a story exist and only one carried the dollar
 * figure, the wrong merge loses that number permanently, and the whole point of
 * the pass is to carry it forward.
 */
function ClusterCard({
  cluster, status, error, onApply, onRetry,
}: {
  cluster: StoryCluster;
  status: ClusterStatus;
  error?: string;
  onApply: () => void;
  onRetry: () => void;
}) {
  const star: Array<[string, string | undefined]> = [
    ["Situation", cluster.situation], ["Task", cluster.task],
    ["Action", cluster.action], ["Result", cluster.result],
  ];
  const pending = status === "queued" || status === "assembling";

  return (
    <div className={`story-card cluster-card is-${status}`}>
      <div className="story-card-head">
        <div className="story-card-title">
          {cluster.title}
          {cluster.matches_anchor && <span className="pill pill-accepted">anchor</span>}
          {cluster.company && <span className="pill">{cluster.company}</span>}
          <span className="pill">{cluster.competency}</span>
          {cluster.strength != null && (
            <span className={`pill ${strengthClass(cluster.strength)}`}>strength {cluster.strength}/5</span>
          )}
        </div>
        <div className="muted small">{STATUS_NOTE[status] ?? cluster.source_note}</div>
      </div>

      {/* One failed assembly is one story, not the whole pass — the other cards
          keep filling in behind it, and this one retries on its own. */}
      {status === "error" ? (
        <p className="error small">{error ?? "assembly failed"}</p>
      ) : pending ? (
        <p className="muted small">
          Reading {cluster.variant_titles.length || "all"} telling
          {cluster.variant_titles.length === 1 ? "" : "s"} of this one…
        </p>
      ) : cluster.no_material ? (
        /* An anchor with nothing behind it. Saying "no STAR" here would read as
           a bug; it's the opposite — the clearest record of a story she tells
           out loud and has never written down. */
        <p className="muted small">
          Nothing written down yet — you named this story, but no prep synthesis has ever captured it.
          Saving it banks the title so the next synthesis has somewhere to file it.
        </p>
      ) : (
        <dl className="story-star">
          {star.map(([k, v]) => v && <><dt key={k}>{k}</dt><dd key={`${k}d`}>{v}</dd></>)}
        </dl>
      )}

      {cluster.earned_secret && <p className="small"><em>Earned secret:</em> {cluster.earned_secret}</p>}
      {cluster.sharpen && <p className="small story-sharpen"><strong>Sharpen:</strong> {cluster.sharpen}</p>}
      {cluster.best_for && <div className="story-card-foot">Best for: {cluster.best_for}</div>}

      {/* What accepting this costs. These titles become aliases, so they stop
          being separate entries — worth showing before the click, not after. */}
      {cluster.variant_titles.length > 0 && (
        <p className="muted small">
          Folds in {cluster.variant_titles.length} earlier telling
          {cluster.variant_titles.length === 1 ? "" : "s"}: {cluster.variant_titles.join(" · ")}
        </p>
      )}

      {status === "ready" && (
        <div className="prep-chat-actions">
          <button className="sm" onClick={onApply}>Save to library</button>
        </div>
      )}
      {status === "error" && (
        <div className="prep-chat-actions">
          <button className="ghost sm" onClick={onRetry}>Try this one again</button>
        </div>
      )}
    </div>
  );
}

const UNCATEGORIZED = "Uncategorized";

export default function StoryLibrary() {
  const [stories, setStories] = useState<CoachingStory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [competency, setCompetency] = useState<string | null>(null);

  // Consolidation. `proposal` is the plan's own commentary (unmatched anchors,
  // coverage notes); `clusters` is the working copy, because each one is
  // assembled by its own request and swapped in as it lands.
  const [proposal, setProposal] = useState<StoryConsolidationProposal | null>(null);
  const [clusters, setClusters] = useState<StoryCluster[]>([]);
  const [counts, setCounts] = useState<{ tellings: number; banked: number; anchors: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [clusterState, setClusterState] = useState<Record<string, ClusterStatus>>({});
  const [clusterErrors, setClusterErrors] = useState<Record<string, string>>({});

  // Anchors
  const [editingAnchors, setEditingAnchors] = useState(false);
  const [anchorDraft, setAnchorDraft] = useState("");
  const [savingAnchors, setSavingAnchors] = useState(false);

  // Merge mode — for duplicates that survive a consolidation pass, or that
  // predate it.
  const [mergeMode, setMergeMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);

  function load() {
    fetchStorybank()
      .then((r) => setStories(r.stories ?? []))
      .catch((e) => setError((e as Error).message));
  }

  useEffect(load, []);

  const anchors = useMemo(() => (stories ?? []).filter((s) => s.is_anchor), [stories]);

  function openAnchorEditor() {
    setAnchorDraft(anchors.length ? anchors.map((s) => s.title).join("\n") : ANCHOR_PLACEHOLDER);
    setEditingAnchors(true);
  }

  async function saveAnchors() {
    const titles = anchorDraft.split("\n").map((t) => t.trim()).filter(Boolean);
    if (titles.length === 0) return;
    setSavingAnchors(true); setError(null);
    try {
      await setStoryAnchors(titles);
      setEditingAnchors(false);
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setSavingAnchors(false); }
  }

  /**
   * Assemble planned clusters, a few at a time.
   *
   * One request per story is the whole point — the single call that wrote all
   * of them at once ran past the 150s Edge Function ceiling and came back as an
   * unreadable 504. Three at a time keeps the cards filling in visibly without
   * opening a dozen model calls at once, and a failure is scoped to its own card.
   */
  async function assemble(list: StoryCluster[]) {
    const queue = [...list];
    const worker = async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        setClusterState((s) => ({ ...s, [c.title]: "assembling" }));
        setClusterErrors(({ [c.title]: _gone, ...rest }) => rest);
        try {
          const filled = await assembleStoryCluster(c);
          setClusters((cur) => cur.map((x) => (x.title === c.title ? { ...x, ...filled } : x)));
          setClusterState((s) => ({ ...s, [c.title]: "ready" }));
        } catch (e) {
          setClusterErrors((s) => ({ ...s, [c.title]: (e as Error).message }));
          setClusterState((s) => ({ ...s, [c.title]: "error" }));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  async function runConsolidation() {
    setRunning(true); setError(null); setProposal(null); setClusters([]); setClusterErrors({});
    let planned: StoryCluster[] = [];
    try {
      const r = await consolidateStories();
      planned = r.proposal.clusters ?? [];
      setProposal(r.proposal);
      setClusters(planned);
      setCounts(r.input_counts);
      setClusterState(Object.fromEntries(planned.map((c) => [c.title, "queued" as const])));
    } catch (e) { setError((e as Error).message); return; }
    finally { setRunning(false); }
    await assemble(planned);
  }

  async function applyCluster(c: StoryCluster) {
    setClusterState((s) => ({ ...s, [c.title]: "applying" }));
    try {
      await applyStoryCluster(c);
      setClusterState((s) => ({ ...s, [c.title]: "done" }));
      load();
    } catch (e) {
      setError((e as Error).message);
      setClusterState((s) => ({ ...s, [c.title]: "ready" }));
    }
  }

  async function applyAll() {
    const ready = clusters.filter((c) => clusterState[c.title] === "ready");
    // Sequential on purpose: upsert_story resolves aliases, and two concurrent
    // writes that both claim the same variant title would race.
    for (const c of ready) await applyCluster(c);
  }

  async function doMerge() {
    if (picked.length < 2) return;
    setMerging(true); setError(null);
    try {
      // Keeper: an anchor if one is selected (an anchor is never merged away),
      // otherwise the strongest.
      const chosen = (stories ?? []).filter((s) => picked.includes(s.id));
      const keeper =
        chosen.find((s) => s.is_anchor) ??
        [...chosen].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0];
      await mergeStories(keeper.id, picked.filter((id) => id !== keeper.id));
      setPicked([]);
      setMergeMode(false);
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setMerging(false); }
  }

  const index = useMemo(() => {
    const map = new Map<string, CoachingStory[]>();
    for (const s of stories ?? []) {
      const key = s.competency?.trim() || UNCATEGORIZED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [stories]);

  const competencyList = useMemo(
    () => [...index.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])),
    [index],
  );

  useEffect(() => {
    if (!competency && competencyList.length > 0) setCompetency(competencyList[0][0]);
  }, [competency, competencyList]);

  const shown = useMemo(() => {
    const all = competency ? index.get(competency) ?? [] : [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) =>
      [s.title, s.company, s.competency, s.situation, s.task, s.action, s.result,
       s.earned_secret, s.best_for, ...aliasesOf(s)]
        .filter(Boolean).join(" \n ").toLowerCase().includes(q));
  }, [index, competency, query]);

  if (error && !stories) return <p className="error">{error}</p>;
  if (!stories) return <p className="muted">Loading…</p>;

  const empty = stories.length === 0;
  const stillAssembling = clusters.filter(
    (c) => (clusterState[c.title] ?? "queued") === "queued" || clusterState[c.title] === "assembling",
  ).length;

  return (
    <section>
      {error && <p className="error small" style={{ marginTop: "0.9rem" }}>{error}</p>}

      <div className="section-head" style={{ marginTop: "0.9rem" }}>
        <p className="muted small" style={{ margin: 0, flex: 1 }}>
          Your durable story inventory — {stories.length} stor{stories.length === 1 ? "y" : "ies"}
          {anchors.length > 0 && `, ${anchors.length} anchored`}. Not a per-session rollup: strength,
          earned secret, and how recently you actually told each one persist here across the whole search.
        </p>
        <button className="ghost sm" onClick={openAnchorEditor}>
          {anchors.length ? "Edit anchors" : "Set my anchor stories"}
        </button>
        <button className="ghost sm" onClick={runConsolidation} disabled={running}>
          {running ? "Consolidating…" : "Consolidate…"}
        </button>
      </div>

      {editingAnchors && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>The stories you keep coming back to</h3>
          <p className="muted small">
            One per line, in your own words. These are the titles the library files everything
            under — consolidation folds each variant into the anchor it belongs to and never merges
            an anchor away. An anchor with nothing written against it is kept deliberately: it's the
            clearest signal of a story you tell out loud but have never written down.
          </p>
          <textarea
            rows={12}
            value={anchorDraft}
            onChange={(e) => setAnchorDraft(e.target.value)}
            disabled={savingAnchors}
          />
          <div className="modal-actions">
            <button className="ghost" onClick={() => setEditingAnchors(false)} disabled={savingAnchors}>
              Cancel
            </button>
            <button onClick={saveAnchors} disabled={savingAnchors}>
              {savingAnchors ? "Saving…" : "Save anchors"}
            </button>
          </div>
        </div>
      )}

      {proposal && (
        <div className="card consolidation">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>
              Proposed library <span className="count">· {clusters.length} stories</span>
            </h3>
            <button
              className="sm"
              onClick={applyAll}
              disabled={!Object.values(clusterState).some((s) => s === "ready")}
            >
              Save all{stillAssembling > 0 ? " that are ready" : ""}
            </button>
            <button className="ghost sm" onClick={() => setProposal(null)}>Dismiss</button>
          </div>
          {counts && (
            <p className="muted small">
              Read {counts.tellings} telling{counts.tellings === 1 ? "" : "s"} across your prep
              syntheses plus {counts.banked} banked stor{counts.banked === 1 ? "y" : "ies"}, against{" "}
              {counts.anchors} anchor{counts.anchors === 1 ? "" : "s"}. Nothing is saved until you say so —
              a merge that drops the one telling with the number in it can't be undone.
            </p>
          )}
          {/* Each story is written by its own request, so they land one at a
              time. Say so, rather than leaving half the cards looking empty. */}
          {stillAssembling > 0 && (
            <p className="muted small">
              Assembling {stillAssembling} of {clusters.length} — each story is written from its own
              tellings, so they fill in as they finish. You can save the ready ones now.
            </p>
          )}

          {(proposal.unmatched_anchors ?? []).length > 0 && (
            <div className="prep-feedback-card">
              <p className="small">
                <strong>Anchors with no material anywhere:</strong>{" "}
                {proposal.unmatched_anchors!.join(" · ")}
              </p>
              <p className="muted small">
                Stories you say you tell that have never been written down. Highest-value gap in the
                library — rehearse a round that draws on one and synthesis will capture it.
              </p>
            </div>
          )}

          {(proposal.coverage_notes ?? []).length > 0 && (
            <ul className="clean">
              {proposal.coverage_notes!.map((n, i) => <li key={i} className="muted small">· {n}</li>)}
            </ul>
          )}

          {clusters.map((c) => (
            <ClusterCard
              key={c.title}
              cluster={c}
              status={clusterState[c.title] ?? "queued"}
              error={clusterErrors[c.title]}
              onApply={() => applyCluster(c)}
              onRetry={() => assemble([c])}
            />
          ))}
        </div>
      )}

      {empty ? (
        <p className="muted">
          The library is empty. If you've synthesized prep sheets before, <strong>Consolidate…</strong>{" "}
          pulls every story out of them and folds the repeats together — that's the one-off backfill.
          After that, each prep synthesis writes here automatically.
        </p>
      ) : (
        <div className="library-shell">
          <div className="library-rail">
            <div className="library-rail-label">By competency</div>
            <ul className="library-nav">
              {competencyList.map(([name, entries]) => (
                <li
                  key={name}
                  className={competency === name ? "active" : ""}
                  onClick={() => setCompetency(name)}
                >
                  <span>{name}</span>
                  <span className="count">{entries.length}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="library-main">
            <div className="section-head">
              <input
                type="search"
                placeholder="Search stories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              {mergeMode ? (
                <>
                  <button className="sm" disabled={picked.length < 2 || merging} onClick={doMerge}>
                    {merging ? "…" : `Merge ${picked.length} → 1`}
                  </button>
                  <button className="ghost sm" onClick={() => { setMergeMode(false); setPicked([]); }}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="ghost sm" onClick={() => setMergeMode(true)}>Merge duplicates…</button>
              )}
            </div>
            {mergeMode && (
              <p className="muted small">
                Tick two or more. They collapse into one keeper — an anchor if you picked one,
                otherwise the strongest — and the rest become aliases on it, so a later prep
                synthesis can't re-create them.
              </p>
            )}
            {competency && (
              <>
                <h2 className="library-heading">{competency}</h2>
                <p className="muted small">
                  {shown.length} stor{shown.length === 1 ? "y" : "ies"}
                  {" · "}
                  {shown.filter((s) => (s.strength ?? 0) >= 4).length} ready to tell
                  {" · "}
                  {shown.filter((s) => !s.earned_secret && (s.situation || s.action)).length} without an earned secret
                </p>
              </>
            )}
            {shown.map((s) => (
              <LibraryStory
                key={s.id}
                story={s}
                onChanged={load}
                mergeMode={mergeMode}
                mergeSelected={picked.includes(s.id)}
                onPickMerge={(id) =>
                  setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
              />
            ))}
            {shown.length === 0 && <p className="muted">No matches.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
