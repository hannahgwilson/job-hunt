// The spikes / gaps-to-address pair, read straight off the best role_fit row
// for the posting (the judge-fit output — see RoleFitPanel).
//
// It renders in two places on purpose: the Interviews → Prep index, where it's
// the whole point of the collapsed card, and the top of the prep page itself.
// One component so the two can't drift into two different-looking readings of
// the same two arrays.
export interface FitHighlights {
  alignment?: number | null;
  summary?: string | null;
  spikes?: string[] | null;
  gaps?: string[] | null;
  resume_label?: string | null;
}

// Whether there's anything worth giving the block room for — callers that own a
// whole card (the prep page) use this to show a "run the judge" hint instead of
// an empty box; callers rendering inside an existing card just render the row.
export function hasFitHighlights(fit: FitHighlights | null | undefined): boolean {
  return Boolean(fit?.spikes?.length || fit?.gaps?.length);
}

export default function FitSpikes({ fit }: { fit: FitHighlights | null | undefined }) {
  return (
    <div className="prep-fit-row">
      <div className="prep-fit-col spikes">
        <h4>Spikes</h4>
        {fit?.spikes?.length
          ? <ul>{fit.spikes.map((s, i) => <li key={i}>{s}</li>)}</ul>
          : <p className="muted small">—</p>}
      </div>
      <div className="prep-fit-col gaps">
        <h4>Gaps to address</h4>
        {fit?.gaps?.length
          ? <ul>{fit.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
          : <p className="muted small">—</p>}
      </div>
    </div>
  );
}
