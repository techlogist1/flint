import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * FIX 9/10: top-level React error boundary. Catches any rendering-path
 * exception from the app (or from a plugin's UI slot) and renders a
 * recoverable error screen instead of white-screening the window. Used by
 * both the main app and the overlay, so a plugin bug in one surface
 * cannot take down the other.
 */
export class FlintErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[flint] uncaught error in ${this.props.label ?? "app"}:`,
      error,
      info,
    );
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const label = (this.props.label ?? "app").toUpperCase();
      return (
        <div className="min-h-screen bg-[var(--bg-void)] px-8 py-8">
          <div className="mx-auto max-w-3xl">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
              FLINT · {label} · RUNTIME ERROR
            </div>
            <h2 className="mt-2 text-[18px] font-medium uppercase tracking-wider text-[var(--status-error)]">
              ■ unhandled exception
            </h2>
            <div className="mt-6 border-l border-[var(--status-error)] pl-4">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                message
              </div>
              <pre className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-bright)]">
                {this.state.error.message}
              </pre>
            </div>
            {this.state.error.stack && (
              <div className="mt-5 border-l border-[var(--border)] pl-4">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  stack
                </div>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {this.state.error.stack}
                </pre>
              </div>
            )}
            <div className="mt-6 flex items-center gap-4 text-[11px] uppercase tracking-wider">
              <button
                onClick={this.handleRetry}
                className="border border-[var(--border-focus)] bg-[var(--bg-elevated)] px-3 py-1 text-[var(--text-primary)] transition-colors duration-100 ease-out hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                [retry]
              </button>
              <span className="text-[var(--text-muted)]">
                restart flint if this keeps happening
              </span>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
