"use client";

/**
 * Phase 28 — Pair detail drawer.
 *
 * (rule #11: the "today vs typical" comparison is descriptive — "typically
 * active", never "best time to trade".)
 *
 * Contents: factor breakdown, mini M5 chart, today's volatility vs the typical
 * value for this hour, and a link to the heatmap.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MiniM5Chart } from "@/components/market/MiniM5Chart";
import { ScoreBar } from "@/components/market/RatingBadge";
import type { MarketSnapshotPair } from "@/server/lib/market-snapshot";

function pctPhrase(percentile: number | null): string {
  if (percentile == null) return "not enough history yet";
  if (percentile < 20) return "quieter than usual for this hour";
  if (percentile > 95) return "unusually active for this hour";
  if (percentile >= 30 && percentile <= 80) return "within the typical range for this hour";
  return percentile < 30 ? "on the quieter side for this hour" : "on the active side for this hour";
}

export function PairDetailDrawer({
  pair,
  open,
  onOpenChange,
}: {
  pair: MarketSnapshotPair | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {pair && (
          <>
            <SheetHeader>
              <SheetTitle data-testid="drawer-title">{pair.displayName}</SheetTitle>
              <SheetDescription>
                Market conditions · updated {pair.ageSeconds}s ago
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-6">
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Factor breakdown</h3>
                <ul className="space-y-3">
                  {pair.factors.map((f) => (
                    <li key={f.key} data-testid={`factor-${f.key}`} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span>{f.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {f.score == null ? "unknown" : `${Math.round(f.score)}/100`}
                        </span>
                      </div>
                      <ScoreBar
                        value={f.score}
                        label={`${f.label} score`}
                        muted={f.score == null}
                      />
                      <p className="text-xs text-muted-foreground">{f.note}</p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Today vs typical for this hour</h3>
                <p className="text-sm text-muted-foreground">
                  Volatility is {pctPhrase(pair.volatilityPercentile)}
                  {pair.volatilityPercentile != null && (
                    <span className="tabular-nums">
                      {" "}
                      ({Math.round(pair.volatilityPercentile)}th percentile)
                    </span>
                  )}
                  .
                </p>
                {pair.spread != null && (
                  <p className="text-sm text-muted-foreground">
                    Spread {pair.spread.toExponential(2)}
                    {pair.spreadRatio != null && (
                      <>
                        {" "}
                        · {pair.spreadRatio.toFixed(1)}× the typical{" "}
                        {pair.typicalSpread?.toExponential(2)}
                      </>
                    )}
                    .
                  </p>
                )}
                {pair.nextNewsTitle && pair.nextNewsMinutesTo != null && (
                  <p className="text-sm text-muted-foreground">
                    Next high-impact news: {pair.nextNewsTitle} in {pair.nextNewsMinutesTo} min.
                  </p>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Recent price (M5)</h3>
                <MiniM5Chart symbol={pair.symbol} />
              </section>

              <section>
                <div className="flex gap-2 mt-4">
                  <Link href={`/app/trades?asset=${pair.symbol}`}>
                    <Button size="sm">
                      Trade Now <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                  </Link>
                  <Link href="/app/market/heatmap">
                    <Button size="sm" variant="outline">
                      View volatility heatmap
                    </Button>
                  </Link>
                </div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
