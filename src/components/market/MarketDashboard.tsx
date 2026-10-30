"use client";

/**
 * Phase 28 — Live market conditions dashboard (client component).
 *
 * (rule #11: persistent disclaimer + descriptive wording. rule #5: mobile-first
 * responsive card grid.)
 *
 * - Live updates via `useMarketStream` (SSE with a 30s polling fallback).
 * - Filters: GOOD only, hide closed markets, favorites (star, server-persisted).
 * - Click a card → factor-breakdown drawer with a mini M5 chart.
 * - Outage banner + greyed ratings when the provider/worker is stale.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Star, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Checkbox } from "@/components/ui/checkbox";
import { PairDetailDrawer } from "@/components/market/PairDetailDrawer";
import { RatingBadge, ScoreBar } from "@/components/market/RatingBadge";
import { toggleFavoriteAction } from "@/server/actions/market-favorites";
import type { MarketSnapshot, MarketSnapshotPair } from "@/server/lib/market-snapshot";

const DISCLAIMER =
  "Market conditions information only. Not a trading signal or financial advice. Ratings do not predict price direction.";

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `${m}m ago`;
}

export function MarketDashboard({
  initial,
  initialFavorites,
  tradeNowOnly = false,
}: {
  initial: MarketSnapshot;
  initialFavorites: string[];
  tradeNowOnly?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(initial);
  const [status, setStatus] = useState<"connecting" | "live" | "polling" | "error">("polling");
  const [goodOnly, setGoodOnly] = useState(false);
  const [hideClosed, setHideClosed] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(initialFavorites);
  const [selected, setSelected] = useState<MarketSnapshotPair | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetchLive = async () => {
      try {
        const res = await fetch("/api/market/live", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (mounted) {
          setSnapshot(data);
          setStatus("live");
        }
      } catch {}
    };
    fetchLive();
    const id = setInterval(fetchLive, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const stale = snapshot?.isStale ?? true;

  const pairs = useMemo(() => {
    let list = snapshot?.pairs ?? [];
    if (tradeNowOnly) {
      list = list.filter((p) => p.rating === "GOOD" && !p.marketClosed);
      list = list.filter((p) => {
        if (p.newsKnown && p.nextNewsMinutesTo != null && p.nextNewsMinutesTo <= 30) {
          return false;
        }
        return true;
      });
    }
    if (goodOnly) list = list.filter((p) => p.rating === "GOOD");
    if (hideClosed) list = list.filter((p) => !p.marketClosed);
    if (favOnly) list = list.filter((p) => favorites.includes(p.instrumentId));
    return list;
  }, [snapshot, goodOnly, hideClosed, favOnly, favorites, tradeNowOnly]);

  async function onStar(instrumentId: string) {
    const wasFav = favorites.includes(instrumentId);
    setFavorites((prev) =>
      wasFav ? prev.filter((id) => id !== instrumentId) : [...prev, instrumentId],
    );
    try {
      await toggleFavoriteAction({ instrumentId });
    } catch {
      // roll back on failure
      setFavorites((prev) =>
        wasFav ? [...prev, instrumentId] : prev.filter((id) => id !== instrumentId),
      );
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Market conditions</h1>
          <p className="text-sm text-muted-foreground">
            {snapshot?.marketClosed ? "Market closed" : "Market open"} · {pairs.length} pair
            {pairs.length === 1 ? "" : "s"}
            {status === "polling" && " · refreshing every 30s"}
          </p>
        </div>
        <Link
          href="/app/market/heatmap"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Volatility heatmap →
        </Link>
      </header>

      {stale && (
        <div
          data-testid="outage-banner"
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          Market data unavailable. Do not rely on ratings.
          {snapshot?.providerLastError && (
            <span className="block text-xs text-muted-foreground">
              {snapshot.providerLastError}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={goodOnly}
            onCheckedChange={(v) => setGoodOnly(v === true)}
            aria-label="Show only GOOD"
          />
          Show only GOOD
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={hideClosed}
            onCheckedChange={(v) => setHideClosed(v === true)}
            aria-label="Hide closed markets"
          />
          Hide closed markets
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={favOnly}
            onCheckedChange={(v) => setFavOnly(v === true)}
            aria-label="Favorites only"
          />
          Favorites only
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pairs.map((p) => (
          <article
            key={p.instrumentId}
            data-testid="pair-card"
            data-pair={p.symbol}
            className="cursor-pointer rounded-xl border bg-card p-4 hover:border-primary/50"
            onClick={() => {
              setSelected(p);
              setDrawerOpen(true);
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{p.displayName}</span>
              <button
                type="button"
                aria-label={`Star ${p.displayName}`}
                data-testid="star-button"
                onClick={(e) => {
                  e.stopPropagation();
                  void onStar(p.instrumentId);
                }}
              >
                <Star
                  className={`h-4 w-4 ${
                    favorites.includes(p.instrumentId)
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground"
                  }`}
                />
              </button>
            </div>

            <div className="mb-2 flex items-center justify-between">
              <RatingBadge rating={p.rating} muted={stale} />
              <span className="tabular-nums text-sm">{stale ? "—" : p.score}</span>
            </div>

            <div className="mb-2">
              <ScoreBar
                value={stale ? null : p.volatilityPercentile}
                label="Volatility percentile"
                muted={stale}
              />
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline">Session: </dt>
                <dd className="inline">{p.session ?? "—"}</dd>
              </div>
              <div>
                <dt className="inline">Spread: </dt>
                <dd className="inline">{p.spread != null ? p.spread.toExponential(2) : "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="inline">Next news: </dt>
                <dd className="inline">
                  {p.nextNewsTitle
                    ? `${p.nextNewsTitle} (${p.nextNewsMinutesTo ?? "?"} min)`
                    : p.newsKnown
                      ? "none soon"
                      : "unknown"}
                </dd>
              </div>
            </dl>

            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
              {p.reasons[0] ?? "No summary available."}
            </p>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground/70">updated {ago(p.ageSeconds)}</p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = `/app/trades?asset=${p.symbol}`;
                }}
              >
                Trade Now <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </div>
          </article>
        ))}

        {pairs.length === 0 && (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
            No pairs match the current filters.
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground" data-testid="market-disclaimer">
        {DISCLAIMER}
      </p>

      <PairDetailDrawer pair={selected} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}
