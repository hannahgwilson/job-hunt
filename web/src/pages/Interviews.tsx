import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchInterviews, fetchStoryCheatSheet, fetchInterviewPrep } from "../lib/api";
import type {
  InterviewListRow, CheatSheetSession, InterviewPrepStory, InterviewPrep as PrepDoc,
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

type SubTab = "upcoming" | "prep" | "library";

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

  useEffect(() => {
    fetchInterviews().then(setInterviews).catch((e) => setError(e.message));
    fetchStoryCheatSheet()
      .then((r) => {
        if (!r.success) setError(r.error ?? "Could not load the story library.");
        else setSheet(r.sessions);
      })
      .catch((e) => setError(e.message));
  }, []);

  const upcoming = useMemo(() => {
    const now = new Date().toISOString();
    return (interviews ?? [])
      .filter((iv) => iv.scheduled_at && iv.scheduled_at >= now && iv.status === "scheduled")
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
  }, [interviews]);

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
        <button className={sub === "prep" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("prep")}>
          Prep <span className="count">· {interviews.length}</span>
        </button>
        <button className={sub === "library" ? "sub-tab active" : "sub-tab"} onClick={() => setSub("library")}>
          Story library <span className="count">· {[...index.values()].reduce((n, v) => n + v.length, 0)}</span>
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
                  {iv.interview_type && <span className="pill">{iv.interview_type.replace(/_/g, " ")}</span>}
                </div>
                <div className="upcoming-role muted">
                  {iv.role_title ?? (iv.contact_name ? `w/ ${iv.contact_name}` : "—")}
                </div>
                <p className="small" style={{ marginTop: "0.5rem" }}>
                  <button className="linklike" onClick={() => openPrepFor(iv.id)}>Open prep →</button>
                </p>
              </div>
            ))}
          </div>
          <div className="upcoming-legend">
            <span><i className="k-interview" />Interview — tied to an application</span>
            <span><i className="k-networking" />Networking call — tied to a contact, application optional</span>
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
                        {iv.interview_type && <span className="pill">{iv.interview_type.replace(/_/g, " ")}</span>}
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

                          {session && session.stories.length > 0 && (
                            <>
                              <h4 className="prep-stories-h">Stories queued, matched to what this loop probes for</h4>
                              <ul className="clean prep-story-list">
                                {session.stories.map((story, i) => (
                                  <li key={i} className="prep-story-row">
                                    {story.title}
                                    {story.competency && <span className="competency-pill pill">{story.competency}</span>}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}

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
              <div className="library-card" key={i}>
                <div className="library-card-head">
                  <div className="library-card-title">{story.title}</div>
                  <div className="muted small">from {session.organization_name} prep</div>
                </div>
                {story.situation || story.task || story.action || story.result ? (
                  <dl className="library-star">
                    {story.situation && <><dt>Situation</dt><dd>{story.situation}</dd></>}
                    {story.task && <><dt>Task</dt><dd>{story.task}</dd></>}
                    {story.action && <><dt>Action</dt><dd>{story.action}</dd></>}
                    {story.result && <><dt>Result</dt><dd>{story.result}</dd></>}
                  </dl>
                ) : (
                  <p>{story.story}</p>
                )}
                {story.best_for && <div className="library-card-foot">Best for: {story.best_for}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
