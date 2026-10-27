"use client";

/**
 * Phase 22 — News countdown client component.
 *
 * Renders a live countdown to the next event. Re-renders every second.
 * Calls `getNextEventAction` on mount + re-fetches every 60s.
 */
import { useEffect, useState, useTransition } from "react";
import { Clock } from "lucide-react";
import { getNextEventAction, type NewsEventRow } from "@/server/actions/news";

function formatCountdown(minutes: number): string {
  if (minutes < 0) return "imminent";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

export function NewsCountdown() {
  const [nextEvent, setNextEvent] = useState<NewsEventRow | null>(null);
  const [minutesUntil, setMinutesUntil] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    async function fetchNext() {
      const res = await getNextEventAction();
      if (cancelled) return;
      setNextEvent(res.nextEvent ?? null);
      setMinutesUntil(res.minutesUntil ?? null);
    }
    startTransition(fetchNext);
    // Re-fetch every 60s.
    const interval = setInterval(() => startTransition(fetchNext), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!nextEvent || minutesUntil == null) {
    return (
      <div
        className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground"
        data-testid="news-countdown-empty"
      >
        No upcoming high-impact events scheduled.
      </div>
    );
  }

  const impactColor =
    nextEvent.impact === "HIGH"
      ? "text-loss"
      : nextEvent.impact === "MEDIUM"
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <div
      className="rounded-md border border-info/30 bg-info/5 p-3 flex items-center justify-between gap-3"
      data-testid="news-countdown"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="rounded-full bg-info/15 p-2 shrink-0">
          <Clock className="size-5 text-info" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{nextEvent.title}</div>
          <div className="text-xs text-muted-foreground">
            <span className={impactColor}>{nextEvent.impact}</span>
            {" · "}
            {nextEvent.currency === "*" ? "Global" : nextEvent.currency}
            {" · "}
            {new Date(nextEvent.scheduledAt).toLocaleString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              month: "short",
              day: "numeric",
            })}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div
          className="text-lg font-bold tabular-nums text-info"
          data-testid="news-countdown-minutes"
        >
          {formatCountdown(minutesUntil)}
        </div>
        <div className="text-[10px] text-muted-foreground">until event</div>
      </div>
    </div>
  );
}
