"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";

/**
 * error.tsx — Next.js Error Boundary for the entire app. Catches render
 * errors and shows a recoverable UI. Logs to the console for Phase 13's
 * Sentry integration to capture later.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RiskGuard] render error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center space-y-4">
        <AlertTriangle className="mx-auto size-10 text-destructive" aria-hidden="true" />
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          An unexpected error occurred while rendering this page. You can try again — if it keeps
          happening, sign out and back in.
        </p>
        {error.digest && (
          <p className="text-xs font-mono text-muted-foreground">Digest: {error.digest}</p>
        )}
        <div className="flex gap-2 justify-center">
          <Button onClick={reset} variant="default">
            <RefreshCw className="size-4 mr-2" aria-hidden="true" />
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
