"use client";

/**
 * Phase 29 — Live market-rating panel for the Add Trade form.
 *
 * Client component. Calls `getMarketEdgeAction` on mount + whenever the
 * asset or account changes and renders:
 *   - GOOD   → quiet green badge (descriptive, no hype),
 *   - CAUTION → yellow warning (the spec's "yellow warn"),
 *   - AVOID  → red panel (the confirm dialog itself opens from the form's
 *     submit flow — this panel is the persistent reminder),
 *   - no data → "No market data for this instrument" (OTC / unknown pairs)
 *     and no rating is ever shown for them.
 *
 * Also surfaces the trader's own historical result for this pair × session
 * when the group has ≥ 30 trades; otherwise "need more trades" copy.
 *
 * Hydration-safe: hidden on the server render (initial state is loading) —
 * mirrors the NewsTradeWarning pattern.
 */
import { useEffect, useState, useTransition } from "react";
import { Activity, AlertTriangle, Database, Info } from "lucide-react";
import { getMarketEdgeAction } from "@/server/actions/market-edge";
import type { PrepareMarketInfo } from "@/server/actions/pre-trade-types";
import { cn } from "@/lib/utils";

const RATING_STYLES: Record<
  "GOOD" | "CAUTION" | "AVOID",
  { wrapper: string; badge: string; icon: typeof Activity }
> = {
  GOOD: {
    wrapper: "border-profit/40 bg-profit/10 text-profit",
    badge: "bg-profit/15 text-profit",
    icon: Activity,
  },
  CAUTION: {
    wrapper: "border-warning/40 bg-warning/10 text-warning",
    badge: "bg-warning/15 text-warning",
    icon: AlertTriangle,
  },
  AVOID: {
    wrapper: "border-loss/40 bg-loss/10 text-loss",
    badge: "bg-loss/15 text-loss",
    icon: AlertTriangle,
  },
};

export function MarketRatingPanel({
  asset,
  tradingAccountId,
}: {
  asset: string;
  tradingAccountId: string;
}) {
  const [market, setMarket] = useState<PrepareMarketInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    startTransition(async () => {
      try {
        const res = await getMarketEdgeAction({ asset, tradingAccountId });
        if (cancelled) return;
        setMarket(res.market ?? { hasData: false });
      } catch {
        if (!cancelled) setMarket({ hasData: false });
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset, tradingAccountId]);

  if (loading || !market) return null;

  // OTC / unknown instrument / stale feed — never a guessed rating.
  if (!market.hasData || !market.rating) {
    return (
      <div
        className="mt-2 flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground"
        data-testid="market-rating-panel"
        data-rating="NONE"
      >
        <Database className="size-3.5 shrink-0" aria-hidden="true" />
        <span>No market data for this instrument</span>
      </div>
    );
  }

  const style = RATING_STYLES[market.rating];
  const Icon = style.icon;
  const personal = market.personal;

  return (
    <div
      className={cn("mt-2 space-y-1.5 rounded-md border p-2", style.wrapper)}
      data-testid="market-rating-panel"
      data-rating={market.rating}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className={cn("rounded px-1.5 py-0.5 font-bold", style.badge)}>
          {market.rating}
          {market.score != null ? ` · ${market.score}` : ""}
        </span>
        <span className="opacity-80">
          {market.session ? `${market.session} session` : "current conditions"}
          {market.volatilityPercentile != null
            ? ` · volatility ${Math.round(market.volatilityPercentile)}th percentile`
            : ""}
        </span>
      </div>

      {market.rating === "AVOID" && (
        <p className="text-[11px] leading-snug">
          Conditions look unfavorable right now — you&apos;ll be asked to confirm before saving
          this trade.
        </p>
      )}
      {market.rating === "CAUTION" && (
        <p className="text-[11px] leading-snug">
          Mixed conditions for this pair — double-check your setup before entry.
        </p>
      )}

      {personal ? (
        <p className="text-[11px] opacity-80" data-testid="market-rating-personal">
          Your record here: {personal.trades} trades in {market.session ?? "this session"}, win
          rate {Math.round(personal.winRate * 100)}% (range {Math.round(personal.winRateLow * 100)}
          –{Math.round(personal.winRateHigh * 100)}%). Past results don&apos;t guarantee future
          outcomes.
        </p>
      ) : (
        <p className="text-[11px] opacity-70">
          Your history for this pair in {market.session ?? "this session"}: need more trades (at
          least 30) to describe a pattern.
        </p>
      )}

      <p className="flex items-center gap-1 text-[10px] opacity-70">
        <Info className="size-3 shrink-0" aria-hidden="true" />
        Advisory only — ratings describe current conditions, they never block a trade.
      </p>
    </div>
  );
}
