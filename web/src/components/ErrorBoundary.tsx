import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render-time throws so one bad row can't take down the app.
 *
 * Without this, React unmounts the whole tree on an uncaught render error — and
 * because the nav and the routes share a root, that means a white page with no
 * header, no way to navigate away, and nothing on screen saying what happened.
 * A persisted AI artifact missing an array field did exactly that to the
 * interview-prep page.
 *
 * Keyed by route in App, so navigating elsewhere resets it rather than leaving
 * the boundary latched open on a page that was never broken.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <h1>This page hit an error</h1>
        <p className="muted small">
          The rest of the app still works — use the nav above. If this page keeps
          failing, the details below are what to report.
        </p>
        <pre className="error small error-boundary-detail">{this.state.error.message}</pre>
        <button className="ghost sm" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
