"use client";

import { useEffect } from "react";

/**
 * Next-native route-segment error boundary. Catches any error thrown
 * during render of children inside the root layout. The `reset()` prop
 * lets the user retry the failed render without a full page reload.
 *
 * For more granular handling, see `components/ErrorBoundary.tsx`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.error("[route error]", error);
    }
  }, [error]);

  return (
    <div className="max-w-xl mx-auto px-4 py-20 text-center">
      <h2 className="text-2xl font-bold mb-2">Something went wrong</h2>
      <p className="text-foreground-secondary mb-6">
        {error.message || "An unexpected error occurred."}
      </p>
      <div className="flex gap-3 justify-center">
        <button
          type="button"
          onClick={reset}
          className="px-4 py-2 bg-mint text-background font-medium text-sm rounded-lg hover:bg-mint-dim transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          className="px-4 py-2 text-sm border border-border rounded-lg hover:border-mint/50 hover:text-mint transition-colors"
        >
          Go home
        </button>
      </div>
      {error.digest && (
        <p className="mt-6 text-xs font-mono text-foreground-secondary/60">
          digest: {error.digest}
        </p>
      )}
    </div>
  );
}
