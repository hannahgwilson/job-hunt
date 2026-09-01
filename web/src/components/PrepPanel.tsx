import type { ReactNode } from "react";

/**
 * The one panel shell every block on the interview-prep page uses.
 *
 * The prep page used to be nine `.card` sections of identical weight, each with
 * its own generate button, in an order that didn't match the order you actually
 * use them. The fix is structural — three phase tabs — but it only reads as a
 * flow if every block inside a tab states the same two things in the same
 * place: is this built yet, and can I build it now.
 *
 * `state` is that first answer, rendered as a chip in the head. `locked` is the
 * second: a block that isn't available yet renders the *reason* rather than
 * disappearing, so the shape of the flow is visible on the first visit instead
 * of materialising card by card as you fill things in.
 */
export type PrepPanelState = "ready" | "empty" | "locked" | "working";

const STATE_LABEL: Record<PrepPanelState, string> = {
  ready: "ready",
  empty: "not built",
  locked: "locked",
  working: "working…",
};

export function PrepStateChip({ state }: { state: PrepPanelState }) {
  return <span className={`pp-state is-${state}`}>{STATE_LABEL[state]}</span>;
}

export default function PrepPanel({
  id,
  title,
  state,
  meta,
  actions,
  locked,
  children,
}: {
  /** Scroll target — the "next step" bar jumps here. */
  id?: string;
  title: string;
  state?: PrepPanelState;
  /** Right-aligned provenance, e.g. "generated 11 Aug". */
  meta?: string;
  actions?: ReactNode;
  /** Why this block isn't available yet. Renders instead of the body. */
  locked?: string;
  children?: ReactNode;
}) {
  return (
    <section className="panel prep-panel" id={id}>
      <div className="panel-head">
        <h2>{title}</h2>
        {(locked || state) && <PrepStateChip state={locked ? "locked" : state!} />}
        {meta && <span className="meta">{meta}</span>}
        {actions && !locked && <span className="pp-head-actions">{actions}</span>}
      </div>
      {locked ? <p className="panel-empty pp-locked">{locked}</p> : <div className="panel-body">{children}</div>}
    </section>
  );
}
