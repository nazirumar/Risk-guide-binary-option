"use client";

/**
 * Phase 22 — News warning panel for the Add Trade form.
 *
 * Client component. Calls `getNewsWarningAction` on mount + whenever the
 * asset changes. Renders a non-blocking red warning panel when there are
 * relevant upcoming high-impact events for the traded pair's currencies
 * within the user's configured warning window (default 15 min).
 *
 * The warning is NON-BLOCKING by design — the spec says "never block
 * trading" — the trader may have a good reason to take the trade (e.g.
 * the news was already released, the market has settled). The discipline
 * move is to surface the stat, not prevent the trade.
 *
 * Hydration-safe: hidden on the server render (initial state has no
 * events) + surfaces only after the client fetches the warning decision.
 */
import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { getNewsWarningAction } from "@/server/actions/news";
import type { RelevantEvent } from "@/lib/news/warning";

export function NewsTradeWarning({ asset }: { asset: string }) {
  const [state, setState] = useState<{
    loading: boolean;
    warningEnabled: boolean;
    minutes: number;
    relevantEvents: RelevantEvent[];
  }>({ loading: true, warningEnabled: false, minutes: 15, relevantEvents: [] });
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      const res = await getNewsWarningAction({ asset });
      if (cancelled) return;
      setState({
        loading: false,
        warningEnabled: !!res.warningEnabled,
        minutes: res.minutes ?? 15,
        relevantEvents: res.relevantEvents ?? [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  if (state.loading || !state.warningEnabled || state.relevantEvents.length === 0) {
    return null;
  }

  return (
    <div
      className="mt-2 rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss space-y-1"
      data-testid="news-trade-warning"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-3.5" aria-hidden="true" />
        High-impact news within {state.minutes} min — consider waiting
      </div>
      <ul className="space-y-0.5">
        {state.relevantEvents.map((e, i) => (
          <li key={`${e.title}-${i}`} className="flex items-center gap-1.5">
            <Clock className="size-3" aria-hidden="true" />
            <span className="font-medium">{e.title}</span>
            <span className="opacity-80">
              ({e.currency === "*" ? "global" : e.currency},{" "}
              {e.minutesFromTrade >= 0 ? `+${e.minutesFromTrade}` : e.minutesFromTrade} min)
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[10px] opacity-70">
        Non-blocking — you can still save the trade. Past results don&apos;t guarantee future
        outcomes; this is a discipline aid, not financial advice.
      </p>
      {pending && <span className="text-[10px] opacity-50">Checking…</span>}
    </div>
  );
}
