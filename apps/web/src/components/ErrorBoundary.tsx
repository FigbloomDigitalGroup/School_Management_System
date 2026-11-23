import { Component, type ErrorInfo, type ReactNode } from "react";
import { isApiError } from "@figbloom/shared";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  requestId: string | null;
}

function requestIdOf(error: unknown): string | null {
  if (isApiError(error) && error.requestId) return error.requestId;
  if (error && typeof error === "object" && "requestId" in error && typeof (error as { requestId?: unknown }).requestId === "string") {
    return (error as { requestId: string }).requestId;
  }
  return null;
}

/**
 * Top-level React error boundary (FIG-1901). Catches unexpected render failures so the whole app never turns
 * into a blank white screen, logs the error together with any API request ID, and offers a one-click reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, requestId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, requestId: requestIdOf(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const requestId = requestIdOf(error);
    // Structured console report ready to forward to the crash-reporting SDK once FIG-1886 provisions the account.
    console.error("[Figbloom ErrorBoundary]", {
      message: error.message,
      requestId,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-page px-6 py-12">
        <div className="w-full max-w-[460px] rounded-xl border border-line bg-white p-6">
          <div className="font-mono text-micro tracking-[0.12em] text-warn-ink">SOMETHING WENT WRONG</div>
          <h1 className="mt-2 text-[18px] font-semibold">This page ran into an unexpected error</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            Your saved data is safe. Reload the page to continue; if this keeps happening, share the reference below with support.
          </p>
          {this.state.requestId && (
            <p className="mt-3 rounded-md bg-sunken px-3 py-2 font-mono text-[12px] text-ink-muted">
              Request ID: {this.state.requestId}
            </p>
          )}
          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-forest px-4 py-2 text-[13px] font-semibold text-white hover:opacity-95"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
