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
      return (
        <div
          style={{
            padding: 40,
            color: "#ef4444",
            fontFamily:
              "ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace",
            background: "#1e1e1e",
            minHeight: "100vh",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, marginBottom: 12 }}>
            Flint hit an error
          </h2>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              color: "#e0e0e0",
              marginBottom: 16,
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={this.handleRetry}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid #4a9eff",
              color: "#4a9eff",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
