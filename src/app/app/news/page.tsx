import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import {
  listNewsEventsAction,
  getNewsStatsAction,
  refreshNewsEventsAction,
} from "@/server/actions/news";
import { NewsCountdown } from "@/components/news/NewsCountdown";
import { RefreshNewsButton } from "@/components/news/RefreshNewsButton";
import { EmptyState } from "@/components/trader/EmptyState";
import { Newspaper } from "lucide-react";
import { formatMoney } from "@/lib/format";

/**
 * /app/news — Phase 22 News calendar.
 *
 * Server Component. Layout:
 *   - Header + past-results disclaimer + manual refresh button.
 *   - Countdown to next event (live client component).
 *   - Today's events table (filtered by impact).
 *   - Near-news vs away-from-news trade stats.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId for the
 * user-specific parts; news events are global (no userId scoping).
 */
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ impact?: string }>;
}) {
  const { userId } = await requireUser();
  const sp = await searchParams;
  const impact = sp.impact as "LOW" | "MEDIUM" | "HIGH" | undefined;

  // Compute today's [start, end) UTC window.
  const now = new Date();
  const todayStartUtc = new Date(now);
  todayStartUtc.setUTCHours(0, 0, 0, 0);
  const todayEndUtc = new Date(todayStartUtc);
  todayEndUtc.setUTCDate(todayStartUtc.getUTCDate() + 1);

  // Refresh news (gracefully — provider failure doesn't break the page).
  // This is a no-op if the cron recently refreshed.
  await refreshNewsEventsAction({ fromUtc: todayStartUtc, toUtc: todayEndUtc });

  // List today's events.
  const eventsResult = await listNewsEventsAction({
    fromUtc: todayStartUtc,
    toUtc: todayEndUtc,
    impact,
  });
  const events = eventsResult.events ?? [];

  // Near-news vs away-from-news stats.
  const statsResult = await getNewsStatsAction();
  const statsRows = statsResult.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">News Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Today's economic events + impact on your trades
          </p>
        </div>
        <RefreshNewsButton />
      </div>

      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="news-disclaimer"
      >
        <strong className="text-foreground">Disclaimer.</strong> The news calendar is a discipline
        aid — high-impact events can move the markets sharply. This tool does not predict market
        direction or recommend trade entries/exits. Past results don&apos;t guarantee future
        outcomes.
      </div>

      {/* Countdown */}
      <NewsCountdown />

      {/* Impact filter */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted-foreground">Filter by impact:</span>
        <a
          href="/app/news"
          className={`inline-flex items-center px-2 py-1 rounded-md ${impact == null ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}
        >
          All
        </a>
        {(["HIGH", "MEDIUM", "LOW"] as const).map((level) => (
          <a
            key={level}
            href={`/app/news?impact=${level}`}
            className={`inline-flex items-center px-2 py-1 rounded-md ${impact === level ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}
          >
            {level}
          </a>
        ))}
      </div>

      {/* Today's events table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Today&apos;s events</h2>
        </div>
        {events.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Newspaper}
              title="No events scheduled today"
              description="Either no events are scheduled, or the provider is unreachable and no cached events exist. Try the refresh button above."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="news-events-table">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Currency</th>
                  <th className="px-4 py-2.5">Impact</th>
                  <th className="px-4 py-2.5">Title</th>
                  <th className="px-4 py-2.5">Forecast</th>
                  <th className="px-4 py-2.5">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((e) => {
                  const impactColor =
                    e.impact === "HIGH"
                      ? "text-loss"
                      : e.impact === "MEDIUM"
                        ? "text-warning"
                        : "text-muted-foreground";
                  return (
                    <tr key={e.id} data-testid={`news-event-row-${e.id}`}>
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {new Date(e.scheduledAt).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: "UTC",
                        })}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {e.currency === "*" ? "Global" : e.currency}
                      </td>
                      <td className={`px-4 py-3 font-medium ${impactColor}`}>{e.impact}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{e.title}</div>
                        {e.url && (
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-primary hover:underline"
                          >
                            source
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-xs">{e.forecast ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-xs">{e.actual ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Near-news vs away-from-news stats */}
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Trades near news vs away from news</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Compares your closed trades taken within the warning window of a high-impact event
          (matching the traded pair&apos;s currencies) vs trades taken outside that window.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="news-stats">
          {statsRows.map((row) => (
            <div
              key={row.bucket}
              className="rounded-md border border-border p-3"
              data-testid={`news-stat-${row.bucket}`}
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                {row.bucket === "near-news" ? "Near news" : "Away from news"}
              </div>
              <div className="text-lg font-bold tabular-nums">{row.trades} trades</div>
              <div className="text-xs text-muted-foreground">
                Win rate:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {(row.winRate * 100).toFixed(1)}%
                </span>
                {" · "}
                Net P/L:{" "}
                <span
                  className={`font-medium tabular-nums ${row.netPL >= 0 ? "text-profit" : "text-loss"}`}
                >
                  {formatMoney(row.netPL, "USD", { signed: true })}
                </span>
                {" · "}
                Exp/trade:{" "}
                <span
                  className={`font-medium tabular-nums ${row.expectancyPerTrade >= 0 ? "text-profit" : "text-loss"}`}
                >
                  {formatMoney(row.expectancyPerTrade, "USD", { signed: true })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
