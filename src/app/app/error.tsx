"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";

/**
 * /app/error.tsx — narrower Error Boundary inside the authed shell. Catches
 * render errors for /app/* without losing the sidebar/top-bar context.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RiskGuard] /app render error:", error);
  }, [error]);

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center space-y-4 max-w-md mx-auto mt-10">
      <AlertTriangle className="mx-auto size-10 text-destructive" aria-hidden="true" />
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The page failed to load. You can try again, or go back to the dashboard.
      </p>
      {error.digest && (
        <p className="text-xs font-mono text-muted-foreground">Digest: {error.digest}</p>
      )}
      <div className="flex gap-2 justify-center">
        <Button onClick={reset}>
          <RefreshCw className="size-4 mr-2" aria-hidden="true" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/app/dashboard">Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
