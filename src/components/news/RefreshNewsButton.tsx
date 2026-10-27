"use client";

/**
 * Phase 22 — Manual news refresh button.
 *
 * Calls `refreshNewsEventsAction` (which calls the configured provider +
 * upserts NewsEvent rows). Shows a toast with the result. On provider
 * failure, shows the cached-data notice (the UI keeps showing the existing
 * cached events; the spec says "never block trading").
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshNewsEventsAction } from "@/server/actions/news";
import { toast } from "@/hooks/use-toast";

export function RefreshNewsButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onRefresh() {
    startTransition(async () => {
      const res = await refreshNewsEventsAction();
      if (res.ok) {
        toast({ title: "Refreshed", description: res.message });
      } else {
        // Provider failure — show the cached-data notice as a warning,
        // not an error (per spec: "handle provider downtime gracefully").
        toast({
          title: "Showing cached data",
          description: res.message,
        });
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={pending}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-accent"
      data-testid="refresh-news-button"
    >
      <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden="true" />
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
