import { useEffect, useState } from "react";
import { getCareerProfile, saveCareerProfile } from "../lib/api";
import type { CareerProfile, CareerTrack, TargetTrack } from "../lib/types";

// The personal baseline + ambition the career judge (judge-career) reads to call
// a role step_up / lateral / step_back. Without it the judge can only guess from
// the title; set once here and it grounds every role's "Career move" score.
// See supabase/functions/JUDGE_SIGNALS_SPEC.md.

const BLANK: CareerProfile = {
  current_title: null, current_level: null, current_track: null, current_span: null,
  years_experience: null, current_comp: null, primary_domain: null,
  target_track: null, target_level: null, target_comp_floor: null,
  forward_means: null, lateral_domains: null, notes: null,
};

// "more scope, more comp" <-> ["more scope","more comp"]
const toList = (s: string): string[] | null => {
  const xs = s.split(",").map((x) => x.trim()).filter(Boolean);
  return xs.length ? xs : null;
};
const fromList = (xs: string[] | null): string => (xs ?? []).join(", ");

const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));
const strOrNull = (s: string): string | null => (s.trim() === "" ? null : s);

export default function CareerProfilePanel() {
  const [p, setP] = useState<CareerProfile>(BLANK);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCareerProfile()
      .then((r) => { if (r.profile) setP({ ...BLANK, ...r.profile }); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof CareerProfile>(k: K, v: CareerProfile[K]) {
    setP((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveCareerProfile(p);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <section className="card pb-career-profile">
      <div className="section-head">
        <h2>Career profile</h2>
        <button onClick={save} disabled={busy}>{busy ? "Saving…" : saved ? "Saved ✓" : "Save"}</button>
      </div>
      <p className="muted small">
        Where you are now and what counts as “forward” — the career judge reads
        this to call each role a step up, lateral, or step back. All optional, but
        the more you set, the more personal the call.
      </p>

      <h4 className="spikes-h">Current seat</h4>
      <div className="form-row">
        <label>Title
          <input value={p.current_title ?? ""} onChange={(e) => set("current_title", strOrNull(e.target.value))} placeholder="Senior Software Engineer" />
        </label>
        <label>Level
          <input value={p.current_level ?? ""} onChange={(e) => set("current_level", strOrNull(e.target.value))} placeholder="Senior / Staff / Director" />
        </label>
      </div>
      <div className="form-row">
        <label>Track
          <select value={p.current_track ?? ""} onChange={(e) => set("current_track", (e.target.value || null) as CareerTrack | null)}>
            <option value="">—</option>
            <option value="ic">IC</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <label>Direct reports
          <input type="number" value={p.current_span ?? ""} onChange={(e) => set("current_span", numOrNull(e.target.value))} placeholder="0" />
        </label>
      </div>
      <div className="form-row">
        <label>Years of experience
          <input type="number" value={p.years_experience ?? ""} onChange={(e) => set("years_experience", numOrNull(e.target.value))} placeholder="8" />
        </label>
        <label>Current total comp
          <input type="number" value={p.current_comp ?? ""} onChange={(e) => set("current_comp", numOrNull(e.target.value))} placeholder="220000" />
        </label>
      </div>
      <label>Primary domain
        <input value={p.primary_domain ?? ""} onChange={(e) => set("primary_domain", strOrNull(e.target.value))} placeholder="ML platform, backend infra…" />
      </label>

      <h4 className="spikes-h">What “forward” means to you</h4>
      <div className="form-row">
        <label>Target track
          <select value={p.target_track ?? ""} onChange={(e) => set("target_track", (e.target.value || null) as TargetTrack | null)}>
            <option value="">—</option>
            <option value="ic">Stay / grow as IC</option>
            <option value="manager">Move to management</option>
            <option value="either">Either</option>
          </select>
        </label>
        <label>Target level
          <input value={p.target_level ?? ""} onChange={(e) => set("target_level", strOrNull(e.target.value))} placeholder="Staff / Principal" />
        </label>
      </div>
      <label>Comp floor (won’t step below)
        <input type="number" value={p.target_comp_floor ?? ""} onChange={(e) => set("target_comp_floor", numOrNull(e.target.value))} placeholder="230000" />
      </label>
      <label>A step up means… (comma-separated)
        <input value={fromList(p.forward_means)} onChange={(e) => set("forward_means", toList(e.target.value))} placeholder="more scope, more comp, earlier-stage, more autonomy" />
      </label>
      <label>Domains you’d accept as a lateral pivot (comma-separated)
        <input value={fromList(p.lateral_domains)} onChange={(e) => set("lateral_domains", toList(e.target.value))} placeholder="data infra, ML tooling" />
      </label>
      <label>Anything else that defines “forward”
        <textarea value={p.notes ?? ""} onChange={(e) => set("notes", strOrNull(e.target.value))} rows={2} placeholder="e.g. only want roles with real ML ownership, not glue work" />
      </label>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
