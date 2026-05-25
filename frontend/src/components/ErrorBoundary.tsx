"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so one broken component doesn't blank
 * the entire page. React's `<Suspense>` and Next's error.tsx files only
 * cover server / streaming errors — this catches client renders too.
 *
 * Reset by reloading the page (the boundary intentionally doesn't try
 * to auto-recover; a corrupt state is more confusing than a clear error
 * with a reload button).
 *
 * Wrap individual feature islands you don't trust 100%, not the whole
 * page — failing inside a small boundary localises the damage.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Useful for sentry/etc later. For now just log so we see it during dev.
    if (process.env.NODE_ENV !== "production") {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="border border-danger/30 bg-danger/5 rounded-lg p-4 text-sm"
        >
          <p className="font-medium text-danger mb-1">Something broke.</p>
          <p className="text-foreground-secondary mb-3">
            {this.state.error.message || "Unknown error rendering this section."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-xs px-2 py-1 border border-border rounded-md hover:border-mint/30 hover:text-mint transition-colors"
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
