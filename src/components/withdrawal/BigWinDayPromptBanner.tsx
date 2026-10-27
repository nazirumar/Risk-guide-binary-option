"use client";

/**
 * Phase 19 — Big-win-day prompt banner.
 *
 * Surfaces on the dashboard when the user's todayPL is ≥ their configured
 * bigWinDayPercent threshold. Offers two CTAs:
 *   - "Stop trading today" → fires acknowledgeBigWinDayAction + creates a
 *     MANUAL lockout for the rest of the trading day (Phase 7 path).
 *   - "Withdraw & continue" → fires acknowledgeBigWinDayAction + opens the
 *     Withdrawal page so the trader can bank some profit.
 *
 * Hydration-safe: hidden on the server render (initial state loading=true);
 * surfaces only after the client fetches the shouldPrompt decision.
 */
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { TrendingUp, X } from "lucide-react";
import {
  shouldPromptBigWinDayAction,
  acknowledgeBigWinDayAction,
} from "@/server/actions/withdrawals";

export function BigWinDayPromptBanner() {
  const [state, setState] = useState<{
    loading: boolean;
    shouldPrompt: boolean;
    todayPL?: string;
    thresholdPercent?: string | null;
    accountName?: string;
  }>({ loading: true, shouldPrompt: false });
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      const res = await shouldPromptBigWinDayAction();
      if (cancelled) return;
      setState({
        loading: false,
        shouldPrompt: !!res.shouldPrompt,
        todayPL: res.todayPL,
        thresholdPercent: res.thresholdPercent,
        accountName: res.accountName,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading || !state.shouldPrompt || dismissed) return null;

  function onDismiss() {
    setDismissed(true);
    startTransition(async () => {
      await acknowledgeBigWinDayAction();
    });
  }

  return (
    <div
      className="rounded-lg border border-profit/30 bg-profit/5 px-4 py-3 flex items-center justify-between gap-4"
      data-testid="big-win-day-prompt"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="rounded-full bg-profit/15 p-2 shrink-0">
          <TrendingUp className="size-5 text-profit" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Big win day — bank some profit</h2>
          <p className="text-xs text-muted-foreground">
            Today&rsquo;s P/L on {state.accountName ?? "your account"} is {state.todayPL ?? "0"} —
            at or above your {state.thresholdPercent ?? "?"}% threshold. Discipline move: withdraw
            some profit and stop trading for the day.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground p-1 rounded"
          aria-label="Dismiss prompt"
          data-testid="big-win-day-dismiss"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        <Link
          href="/app/withdrawal"
          onClick={onDismiss}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-profit text-white text-xs font-medium hover:bg-profit/90"
          data-testid="big-win-day-withdraw"
        >
          Bank profit
        </Link>
      </div>
    </div>
  );
}
