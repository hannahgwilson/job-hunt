import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  completeInterview, fetchInterviews, fetchStoryCheatSheet, fetchInterviewPrep,
  findDuplicateInterviews, mergeInterviews,
} from "../lib/api";
import InterviewOutcome from "../components/InterviewOutcome";
import StoryCard from "../components/StoryCard";
import OutcomesPanel from "../components/OutcomesPanel";
import { awaitingDebrief, roundLabel } from "../lib/rounds";
import { decidedRounds } from "../lib/outcomes";
import type {
  Interview, InterviewListRow, CheatSheetSession, InterviewPrepStory, InterviewPrep as PrepDoc,
  DuplicateInterviewGroup,
} from "../lib/types";

// The merged Interviews tab: three sub-views over the same underlying data.
//   Upcoming — at-a-glance grid, interviews + networking calls both.
//   Prep     — chronological, per-round: spikes/gaps + that round's stories,
//              each tagged with the competency it answers.
//   Story library — the standing, cross-company reference, indexed by
//              competency instead of company, for open-ended browsing.
// Networking calls only ever appear in Upcoming/Prep (as a lightweight card) —
// the AI prep flow and story synthesis are scoped to formal interview rounds,
// which are the only ones with a job_posting/role_fit to ground them in.

type SubTab = "upcoming" | "past" | "prep" | "library" | "outcomes";

// advance_decision → pill styling (same mapping as the role page).
const DECISION_PILL: Record<string, string> = {
  advance: "pill-accepted",
  hold: "pill-warn",
  withdraw: "pill-withdrawn",
  rejected: "pill-rejected",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "unscheduled";
  const then = new Date(iso);
  const now = new Date();
  const days = Math.round((then.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86_400_000);
  const time = new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  if (days === -1) return `Yesterday · ${time}`;
  if (days > 1 && days <= 13) return `In ${days} days · ${time}`;
  if (days < -1 && days >= -13) return `${-days} days ago · ${time}`;
  return `${new Date(iso).toLocaleDateString()} · ${time}`;
}

function matchesQuery(iv: InterviewListRow, q: string): boolean {
  if (!q) return true;
  const hay = [iv.organization_name, iv.role_title, iv.interview_type, iv.contact_name, iv.notes]
    .filter(Boolean).join(" \n ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

interface LibraryEntry { session: CheatSheetSession; story: InterviewPrepStory; }

function competencyIndex(sessions: CheatSheetSession[]): Map<string, LibraryEntry[]> {
  const map = new Map<string, LibraryEntry[]>();
  for (const session of sessions) {
    for (const story of session.stories) {
      const key = story.competency?.trim() || "Uncategorized";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ session, story });
    }
  }
  return map;
}

function matchesLibraryQuery(entry: LibraryEntry, q: string): boolean {
  if (!q) return true;
  const { session, story } = entry;
  const hay = [
    session.organization_name, session.role_title, story.title, story.competency,
    story.situation, story.task, story.action, story.result, story.story, story.best_for,
  ].filter(Boolean).join(" \n ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

export default function Interviews() {
  const [sub, setSub] = useState<SubTab>("upcoming");
  const [interviews, setInterviews] = useState<InterviewListRow[] | null>(null);
  const [sheet, setSheet] = useState<CheatSheetSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [prepQuery, setPrepQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [prepDocs, setPrepDocs] = useState<Record<string, { loading: boolean; doc: PrepDoc | null }>>({});

  const [libQuery, setLibQuery] = useState("");
  const [competency, setCompetency] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [pastQuery, setPastQuery] = useState("");

  // Duplicate review (T1.1). null = the read RPC isn't deployed yet — hide the
  // panel rather than erroring the whole tab.
  const [dupes, setDupes] = useState<DuplicateInterviewGroup[] | null>(null);
  const [keeperPick, setKeeperPick] = useState<Record<string, string>>({});
  const [merging, setMerging] = useState<string | null>(null);

  function loadDupes() {
    findDuplicateInterviews().then(setDupes).catch(() => setDupes(null));
  }

  const groupKey = (g: DuplicateInterviewGroup) =>
    `${g.application_id ?? g.organization_id}|${g.scheduled_at}|${g.interview_type ?? ""}`;

  async function mergeGroup(g: DuplicateInterviewGroup) {
    const key = groupKey(g);
    // The SQL orders each group best-keeper-first, so the default pick is [0].
    const keep = keeperPick[key] ?? g.interviews[0]?.id;
    if (!keep) return;
    const merge = g.interviews.map((c) => c.id).filter((id) => id !== keep);
    setMerging(key);
    setError(null);
    try {
      await mergeInterviews(keep, merge);
      loadDupes();
      fetchInterviews().then(setInterviews).catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMerging(null);
    }
  }

  useEffect(() => {
    fetchInterviews().then(setInterviews).catch((e) => setError(e.message));
    loadDupes();
    fetchStoryCheatSheet()
      .then((r) => {
        if (!r.success) setError(r.error ?? "Could not load the story library.");
        else setSheet(r.sessions);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Patch one row in place rather than refetching the whole list — keeps the
  // section a row is sitting in from jumping out from under the cursor mid-edit.
  function patchInterview(updated: Interview) {
    setInterviews((cur) => (cur ?? []).map((iv) => (iv.id === updated.id ? { ...iv, ...updated } : iv)));
  }

  const upcoming = useMemo(() => {
    const now = new Date().toISOString();
    return (interviews ?? [])
      .filter((iv) => iv.scheduled_at && iv.scheduled_at >= now && iv.status === "scheduled")
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
  }, [interviews]);

  // Rounds that happened and were never closed out. The predicate lives in
  // lib/rounds so the Dashboard and the Action Queue nudge off exactly the same
  // set this section lists (T3.1).
  const needsDebrief = useMemo(() => awaitingDebrief(interviews ?? []), [interviews]);

  // Bulk escape hatch for the backlog: mark every overdue round completed with
  // no debrief. Deliberately status-only — sweeping in a rating or a go/no-go
  // you didn't actually think about would poison the funnel metrics.
  async function sweepPast() {
    setSweeping(true);
    setError(null);
    try {
      const updated = await Promise.all(
        needsDebrief.map((iv) => completeInterview({ interviewId: iv.id, status: "completed" })),
      );
      updated.forEach(patchInterview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSweeping(false);
    }
  }

  // Every round that's been closed out — completed, cancelled, or no-show.
  // The pre-merge Interviews page had this and the merge dropped it (T1.4);
  // without it a round vanished the moment you completed it. Newest first.
  const past = useMemo(
    () =>
      (interviews ?? [])
        .filter((iv) => iv.status !== "scheduled" && matchesQuery(iv, pastQuery))
        .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? "")),
    [interviews, pastQuery],
  );

  const storiesByInterview = useMemo(() => {
    const map = new Map<string, CheatSheetSession>();
    for (const s of sheet ?? []) map.set(s.interview_id, s);
    return map;
  }, [sheet]);

  const prepRows = useMemo(() => {
    const now = new Date().toISOString();
    const rows = (interviews ?? []).filter((iv) => matchesQuery(iv, prepQuery));
    const upcomingRows = rows
      .filter((iv) => iv.scheduled_at && iv.scheduled_at >= now && iv.status !== "cancelled")
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
    const pastRows = rows
      .filter((iv) => !upcomingRows.includes(iv))
      .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") * -1);
    return [...upcomingRows, ...pastRows];
  }, [interviews, prepQuery]);

  const index = useMemo(() => competencyIndex(sheet ?? []), [sheet]);
  const competencyList = useMemo(
    () => [...index.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])),
    [index],
  );
  useEffect(() => {
    if (!competency && competencyList.length > 0) setCompetency(competencyList[0][0]);
  }, [competency, competencyList]);
  const libraryEntries = useMemo(() => {
    const all = competency ? index.get(competency) ?? [] : [];
    return all.filter((e) => matchesLibraryQuery(e, libQuery));
  }, [index, competency, libQuery]);

  function openPrepFor(interviewId: string) {
    setSub("prep");
    setExpanded((prev) => new Set(prev).add(interviewId));
  }

  function toggleExpanded(interviewId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(interviewId)) next.delete(interviewId);
      else next.add(interviewId);
      return next;
    });
    if (!prepDocs[interviewId]) {
      setPrepDocs((prev) => ({ ...prev, [interviewId]: { loading: true, doc: null } }));
      fetchInterviewPrep(interviewId)
        .then((doc) => setPrepDocs((prev) => ({ ...prev, [interviewId]: { loading: false, doc } })))
        .catch(() => setPrepDocs((prev) => ({ ...prev, [interviewId]: { loading: false, doc: null } })));
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!interviews || !sheet) return <p className="muted">Loading…</p>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Interviews</h1>
      </div>

      <div className="interviews-subnav">
        <button className={sub === "upcoming" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("upcoming")}>
          Upcoming <span className="count">· {upcoming.length}</span>
        </button>
        <button className={sub === "past" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("past")}>
          Past <span className="count">· {(interviews ?? []).filter((iv) => iv.status !== "scheduled").length}</span>
        </button>
        <button className={sub === "prep" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("prep")}>
          Prep <span className="count">· {interviews.length}</span>
        </button>
        <button className={sub === "library" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("library")}>
          Story library <span className="count">· {[...index.values()].reduce((n, v) => n + v.length, 0)}</span>
        </button>
        <button className={sub === "outcomes" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("outcomes")}>
          Outcomes <span className="count">· {decidedRounds(interviews).length}</span>
        </button>
      </div>

      {sub === "upcoming" && (
        <section>
          <p className="muted small" style={{ marginTop: "0.9rem" }}>Interviews + networking calls, soonest first</p>
          {upcoming.length === 0 && <p className="muted">Nothing scheduled.</p>}
          <div className="upcoming-grid">
            {upcoming.map((iv) => (
              <div className={`upcoming-card k-${iv.category}`} key={iv.id}>
                <div className="upcoming-card-top">
                  <span className="upcoming-when">{formatWhen(iv.scheduled_at)}</span>
                  <span className={`upcoming-kind k-${iv.category}`}>
                    {iv.category === "networking" ? "Networking call" : "Interview"}
                  </span>
                </div>
                <div className="upcoming-co">
                  <Link to={`/company/${iv.organization_id}`}>{iv.organization_name}</Link>
                  {iv.interview_type && <span className="pill">{roundLabel(iv.interview_type)}</span>}
                </div>
                <div className="upcoming-role muted">
                  {iv.role_title ?? (iv.contact_name ? `w/ ${iv.contact_name}` : "—")}
                </div>
                <p className="small" style={{ marginTop: "0.5rem" }}>
                  <button className="linklike" onClick={() => openPrepFor(iv.id)}>Open prep →</button>
                </p>
                <InterviewOutcome interview={iv} onChanged={patchInterview} />
              </div>
            ))}
          </div>
          <div className="upcoming-legend">
            <span><i className="k-interview" />Interview — tied to an application</span>
            <span><i className="k-networking" />Networking call — tied to a contact, application optional</span>
          </div>

          <div className="section-head" style={{ marginTop: "1.6rem" }}>
            <h2 style={{ margin: 0 }}>Needs debrief <span className="count">· {needsDebrief.length}</span></h2>
            {needsDebrief.length > 0 && (
              <button className="ghost sm" disabled={sweeping} onClick={sweepPast}>
                {sweeping ? "…" : "Mark all completed"}
              </button>
            )}
          </div>
          <p className="muted small">These dates have passed but the rounds were never closed out — they still count as pending on the Dashboard.</p>
          {needsDebrief.length === 0 && <p className="muted">Nothing waiting on a debrief.</p>}
          <div className="prep-list">
            {needsDebrief.map((iv) => (
              <div className="prep-card is-open" key={iv.id}>
                <div className="prep-card-head" style={{ cursor: "default" }}>
                  <span>
                    <span className="upcoming-when">{formatWhen(iv.scheduled_at)}</span>
                    <div className="upcoming-co">
                      <Link to={`/company/${iv.organization_id}`}>{iv.organization_name}</Link>
                      {iv.role_title && <span className="muted"> — {iv.role_title}</span>}
                    </div>
                    <div className="muted small">
                      {iv.interview_type && <span className="pill">{roundLabel(iv.interview_type)}</span>}
                      {" · "}{iv.status}
                    </div>
                  </span>
                </div>
                <div className="prep-card-body">
                  {iv.notes && <p className="muted small">{iv.notes}</p>}
                  <p className="small"><Link to={`/interview-prep/${iv.id}`}>Prep →</Link></p>
                  <InterviewOutcome interview={iv} onChanged={patchInterview} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {sub === "past" && (
        <section>
          {(dupes?.length ?? 0) > 0 && (
            <div className="card" style={{ marginTop: "0.9rem" }}>
              <h2 style={{ marginTop: 0 }}>Duplicate rounds <span className="count">· {dupes!.length} group{dupes!.length === 1 ? "" : "s"}</span></h2>
              <p className="muted small">
                Same application, date, and type — usually a re-run calendar import. Pick the copy to keep
                (prep sessions and calendar events follow it); the rest are merged in, never blindly deleted.
              </p>
              {dupes!.map((g) => {
                const key = groupKey(g);
                const keep = keeperPick[key] ?? g.interviews[0]?.id;
                return (
                  <div className="prep-card is-open" key={key} style={{ marginBottom: "0.7rem" }}>
                    <div className="prep-card-head" style={{ cursor: "default" }}>
                      <span>
                        <span className="upcoming-when">{formatWhen(g.scheduled_at)}</span>
                        <div className="upcoming-co">
                          <strong>{g.organization_name ?? "Unknown company"}</strong>
                          {g.title && <span className="muted"> — {g.title}</span>}
                          {g.interview_type && <span className="pill">{roundLabel(g.interview_type)}</span>}
                        </div>
                      </span>
                      <button className="sm" disabled={merging === key} onClick={() => mergeGroup(g)}>
                        {merging === key ? "…" : `Merge ${g.count} → 1`}
                      </button>
                    </div>
                    <div className="prep-card-body">
                      {g.interviews.map((c, i) => (
                        <label key={c.id} className="small" style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", padding: "0.2rem 0" }}>
                          <input
                            type="radio"
                            name={`keep-${key}`}
                            checked={keep === c.id}
                            onChange={() => setKeeperPick((cur) => ({ ...cur, [key]: c.id }))}
                          />
                          <span>
                            <strong>{keep === c.id ? "Keep" : "Merge"}</strong>
                            {i === 0 && <span className="muted"> (suggested)</span>}
                            {" · "}{c.status === "no_show" ? "no-show" : c.status}
                            {c.has_synthesis ? " · prep + summary" : c.has_prep ? " · prep started" : ""}
                            {c.has_event && " · on calendar"}
                            {c.rating != null && ` · ${"★".repeat(c.rating)}`}
                            {c.notes && <span className="muted"> · {c.notes.slice(0, 80)}{c.notes.length > 80 ? "…" : ""}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted small" style={{ marginTop: "0.9rem" }}>
            Finished rounds — completed, cancelled, and no-shows, newest first. Amend a debrief or reopen a mis-click here.
          </p>
          <input
            type="search"
            placeholder="Search past rounds…"
            value={pastQuery}
            onChange={(e) => setPastQuery(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          {past.length === 0 && <p className="muted">Nothing closed out yet.</p>}
          <div className="prep-list">
            {past.map((iv) => (
              <div className="prep-card is-open" key={iv.id}>
                <div className="prep-card-head" style={{ cursor: "default" }}>
                  <span>
                    <span className="upcoming-when">{formatWhen(iv.scheduled_at)}</span>
                    <div className="upcoming-co">
                      <Link to={`/company/${iv.organization_id}`}>{iv.organization_name}</Link>
                      {iv.role_title && <span className="muted"> — {iv.role_title}</span>}
                    </div>
                    <div className="muted small">
                      {iv.interview_type && <span className="pill">{roundLabel(iv.interview_type)}</span>}
                      {iv.category === "networking" && <span className="pill">networking</span>}
                      <span className={`pill pill-${iv.status === "no_show" ? "withdrawn" : iv.status === "cancelled" ? "closed" : "accepted"}`}>
                        {iv.status === "no_show" ? "no-show" : iv.status}
                      </span>
                      {iv.rating != null && <span> {"★".repeat(iv.rating)}</span>}
                      {iv.advance_decision && (
                        <span className={`pill ${DECISION_PILL[iv.advance_decision] ?? ""}`}>{iv.advance_decision}</span>
                      )}
                    </div>
                  </span>
                </div>
                <div className="prep-card-body">
                  {iv.feedback && <p className="small">{iv.feedback}</p>}
                  {iv.decision_notes && <p className="muted small">Decision: {iv.decision_notes}</p>}
                  {!iv.feedback && !iv.decision_notes && iv.notes && <p className="muted small">{iv.notes}</p>}
                  {iv.category !== "networking" && (
                    <p className="small"><Link to={`/interview-prep/${iv.id}`}>Prep session →</Link></p>
                  )}
                  <InterviewOutcome interview={iv} onChanged={patchInterview} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {sub === "prep" && (
        <section>
          <input
            type="search"
            placeholder="Search interviews & calls…"
            value={prepQuery}
            onChange={(e) => setPrepQuery(e.target.value)}
            style={{ marginTop: "0.9rem", maxWidth: 320 }}
          />
          {prepRows.length === 0 && <p className="muted">No matches.</p>}
          <div className="prep-list">
            {prepRows.map((iv) => {
              const isOpen = expanded.has(iv.id);
              const session = storiesByInterview.get(iv.id);
              const doc = prepDocs[iv.id];
              return (
                <div className={isOpen ? "prep-card is-open" : "prep-card"} key={iv.id}>
                  <button className="prep-card-head" onClick={() => toggleExpanded(iv.id)}>
                    <span>
                      <span className="upcoming-when">{formatWhen(iv.scheduled_at)}</span>
                      <div className="upcoming-co">
                        <strong>{iv.organization_name}</strong>
                        {iv.interview_type && <span className="pill">{roundLabel(iv.interview_type)}</span>}
                      </div>
                      <div className="muted small">{iv.role_title ?? (iv.contact_name ? `w/ ${iv.contact_name}` : "—")}</div>
                    </span>
                    <span className="muted small">{isOpen ? "▾ expanded" : "▸ collapsed"}</span>
                  </button>

                  {isOpen && (
                    <div className="prep-card-body">
                      {iv.category === "networking" ? (
                        <p className="muted small">
                          {iv.notes || "No structured prep for calls yet — jot notes on this record directly."}
                        </p>
                      ) : (
                        <>
                          {doc?.loading && <p className="muted small">Loading prep…</p>}
                          {doc?.doc?.success && (
                            <div className="prep-fit-row">
                              <div className="prep-fit-col spikes">
                                <h4>Spikes</h4>
                                {doc.doc.fit?.spikes?.length
                                  ? <ul>{doc.doc.fit.spikes.map((s, i) => <li key={i}>{s}</li>)}</ul>
                                  : <p className="muted small">—</p>}
                              </div>
                              <div className="prep-fit-col gaps">
                                <h4>Gaps to address</h4>
                                {doc.doc.fit?.gaps?.length
                                  ? <ul>{doc.doc.fit.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
                                  : <p className="muted small">—</p>}
                              </div>
                            </div>
                          )}

                          {/* The full story cards render on the prep page — this
                              sub-tab is an index (count + link), not a second,
                              lower-fidelity renderer of the same stories (T1.7). */}
                          <div className="prep-full-link">
                            <span className="muted small">
                              {session ? `${session.stories.length} stories queued for this round` : "No prep synthesized yet"}
                            </span>
                            <Link to={`/interview-prep/${iv.id}`}>Open full prep session →</Link>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {sub === "library" && (
        <section className="library-shell">
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
              {competencyList.length === 0 && <li className="muted small">No stories synthesized yet.</li>}
            </ul>
          </div>
          <div className="library-main">
            <div className="section-head">
              <input
                type="search"
                placeholder="Search stories…"
                value={libQuery}
                onChange={(e) => setLibQuery(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            {competency && (
              <>
                <h2 className="library-heading">{competency}</h2>
                <p className="muted small">
                  {libraryEntries.length} stor{libraryEntries.length === 1 ? "y" : "ies"} tagged for this competency
                  , across {new Set(libraryEntries.map((e) => e.session.organization_id)).size} compan
                  {new Set(libraryEntries.map((e) => e.session.organization_id)).size === 1 ? "y" : "ies"}
                </p>
              </>
            )}
            {libraryEntries.map(({ session, story }, i) => (
              <StoryCard
                key={i}
                story={story}
                source={`from ${session.organization_name} prep`}
                showCompetency={false}
              />
            ))}
          </div>
        </section>
      )}

      {/* Where the debrief data finally pays off (T3.2). */}
      {sub === "outcomes" && <OutcomesPanel interviews={interviews} />}
    </div>
  );
}
