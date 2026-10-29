import Link from "next/link";

/**
 * Phase 28 — "Market now" dashboard widget (server component).
 *
 * (rule #11: descriptive copy only. Shows the top 3 pairs by score plus the
 * next high-impact news event. Static per page load — the live-updating
 * surface is /app/market, which uses SSE.)
 */
import { buildMarketSnapshot } from "@/server/lib/market-snapshot";
import { RatingBadge } from "@/components/market/RatingBadge";

export async function MarketNowWidget() {
  const snapshot = await buildMarketSnapshot();
  const top = snapshot.pairs.slice(0, 3);

  return (
    <section
      data-testid="market-now-widget"
      className="rounded-xl border bg-card p-4"
      aria-label="Market now"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Market now</h2>
        <Link
          href="/app/market"
          className="text-xs text-primary underline-offset-4 hover:underline"
        >
          Open dashboard →
        </Link>
      </div>

      {snapshot.isStale ? (
        <p className="text-sm text-muted-foreground">
          Market data unavailable. Do not rely on ratings.
        </p>
      ) : top.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pairs scored yet.</p>
      ) : (
        <ul className="space-y-2">
          {top.map((p) => (
            <li key={p.instrumentId} className="flex items-center justify-between text-sm">
              <span>{p.displayName}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted-foreground">{p.score}</span>
                <RatingBadge rating={p.rating} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t pt-3">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Next high-impact news
        </h3>
        {snapshot.nextNews ? (
          <p className="text-sm">
            {snapshot.nextNews.currency} — {snapshot.nextNews.title}{" "}
            <span className="text-muted-foreground">in {snapshot.nextNews.minutesTo} min</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No upcoming high-impact events.</p>
        )}
      </div>
    </section>
  );
}
