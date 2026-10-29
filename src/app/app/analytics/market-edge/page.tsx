/**
 * Phase 29 — `/app/analytics/market-edge`: personal edge by market condition.
 *
 * (PROJECT_RULES.md rule #11: every number here is a descriptive look at the
 * trader's OWN past trades — no predictions, no signals, no promises. Every
 * table row carries sample size + the Phase 20 reliability tier; groups under
 * 30 trades are marked INSUFFICIENT and never used to draw conclusions.)
 *
 * Layout: disclaimer → summary → GOOD/CAUTION/AVOID comparison → best &
 * worst combinations → pair × session heatmap → full tables (pair × session,
 * pair × hour, volatility bucket) → plain-language insights → disclaimer.
 */
import Link from "next/link";
import { ArrowLeft, BarChart3, Info, TrendingDown, TrendingUp } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { getMarketEdgeReport } from "@/server/lib/market-edge";
import { NEED_MORE_TRADES, type EdgeGroup } from "@/lib/calc/edge";
import { SESSION_DEFINITIONS, type SessionKey } from "@/lib/news/sessions";
import { formatMoney, formatPercent } from "@/lib/format";
import { EmptyState } from "@/components/trader/EmptyState";
import { StatCard } from "@/components/trader/StatCard";
import { cn } from "@/lib/utils";

/** Same colors as the Phase 20 ReliabilityBadge (kept local so this page
 *  stays a server component — the Phase 20 badge takes a full assessment). */
const REL_STYLES: Record<string, string> = {
  INSUFFICIENT: "bg-muted text-muted-foreground border-muted-foreground/20",
  LOW: "bg-warning/15 text-warning border-warning/30",
  MEDIUM: "bg-info/15 text-info border-info/30",
  HIGH: "bg-profit/15 text-profit border-profit/30",
};

function ReliabilityTag({ rating }: { rating: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
        REL_STYLES[rating] ?? REL_STYLES.INSUFFICIENT,
      )}
      data-testid={`edge-reliability-${rating.toLowerCase()}`}
    >
      {rating}
    </span>
  );
}

const pct = (x: number, decimals = 0) =>
  formatPercent(x, { alreadyPercent: false, decimals });

const SESSION_ORDER: SessionKey[] = [
  "ASIAN",
  "LONDON",
  "NEW_YORK",
  "ASIAN_LONDON_OVERLAP",
  "LONDON_NY_OVERLAP",
  "OFF_HOURS",
];

function Range({ g }: { g: EdgeGroup }) {
  if (g.reliability === "INSUFFICIENT") {
    return <span className="text-xs text-muted-foreground">{NEED_MORE_TRADES}</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      range {pct(g.winRateLow)}–{pct(g.winRateHigh)}%
    </span>
  );
}

export default async function MarketEdgePage() {
  const { userId, timezone, baseCurrency } = await requireUser();
  const report = await getMarketEdgeReport(userId, timezone || "UTC");

  const disclaimer = (
    <p className="text-xs text-muted-foreground" data-testid="edge-disclaimer">
      Past results do not guarantee future results. Every number below describes your historical
      trades only — this is not advice and not a prediction.
    </p>
  );

  if (report.totalTrades === 0) {
    return (
      <div className="space-y-6">
        <PageHeader />
        {disclaimer}
        <EmptyState
          icon={BarChart3}
          title="No closed trades yet"
          description="Close a few trades and their market snapshots will build your personal edge report. New trades store the live market rating at save time."
          actionLabel="Go to Trades"
          actionHref="/app/trades"
        />
      </div>
    );
  }

  // Heatmap dims: pairs by total trades, sessions present in the data.
  const sessionKeys = SESSION_ORDER.filter((s) =>
    report.byPairSession.some((e) => e.session === s),
  );
  const pairTotals = new Map<string, number>();
  for (const e of report.byPairSession) {
    pairTotals.set(e.pair, (pairTotals.get(e.pair) ?? 0) + e.group.trades);
  }
  const pairs = Array.from(pairTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([p]) => p);
  const cellOf = (pair: string, session: string) =>
    report.byPairSession.find((e) => e.pair === pair && e.session === session)?.group ?? null;

  const ratingOrder = ["GOOD", "CAUTION", "AVOID", "No data"];
  const ratingGroups = ratingOrder
    .map((k) => report.byRating.find((g) => g.key === k))
    .filter((g): g is EdgeGroup => g != null);

  const snapshotTrades = report.totalTrades - report.tradesWithoutSnapshot;

  return (
    <div className="space-y-6">
      <PageHeader />
      {disclaimer}

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Closed trades analyzed"
          value={report.totalTrades}
          delta={`${snapshotTrades} with market snapshot`}
          icon={BarChart3}
        />
        <StatCard
          label="Best combination"
          value={report.bestWorst.best?.key ?? "—"}
          delta={
            report.bestWorst.best
              ? `${report.bestWorst.best.trades} trades · ${pct(report.bestWorst.best.winRate)}% WR`
              : NEED_MORE_TRADES
          }
          trend={report.bestWorst.best ? "up" : "neutral"}
          icon={TrendingUp}
        />
        <StatCard
          label="Weakest combination"
          value={report.bestWorst.worst?.key ?? "—"}
          delta={
            report.bestWorst.worst
              ? `${report.bestWorst.worst.trades} trades · ${pct(report.bestWorst.worst.winRate)}% WR`
              : NEED_MORE_TRADES
          }
          trend={report.bestWorst.worst ? "down" : "neutral"}
          icon={TrendingDown}
        />
        <StatCard
          label="Insights generated"
          value={report.insights.length}
          delta={`${report.byPairSession.length} pair × session groups`}
          icon={Info}
        />
      </div>

      {/* GOOD vs CAUTION vs AVOID comparison */}
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h2 className="text-base font-semibold">Your results by market rating</h2>
        <p className="text-xs text-muted-foreground">
          The rating each trade was saved with. Trades without a snapshot (recorded before live
          conditions existed, or no data for that instrument) appear as &ldquo;No data&rdquo;.
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {ratingGroups.map((g) => (
            <div
              key={g.key}
              className={cn(
                "rounded-md border p-3 space-y-1",
                g.key === "GOOD"
                  ? "border-profit/30 bg-profit/5"
                  : g.key === "CAUTION"
                    ? "border-warning/30 bg-warning/5"
                    : g.key === "AVOID"
                      ? "border-loss/30 bg-loss/5"
                      : "border-border bg-muted/30",
              )}
              data-testid={`edge-rating-card-${g.key.toLowerCase().replace(/\s/g, "-")}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{g.key}</span>
                <ReliabilityTag rating={g.reliability} />
              </div>
              <div className="text-xl font-bold tabular-nums">{pct(g.winRate)}%</div>
              <div className="text-[11px] text-muted-foreground">
                {g.trades} trade{g.trades === 1 ? "" : "s"}
              </div>
              <Range g={g} />
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {g.expectancy >= 0 ? "+" : ""}
                {formatMoney(g.expectancy, baseCurrency, { signed: true })}/trade
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Best & worst combinations */}
      <section
        className="rounded-lg border border-border p-4 space-y-3"
        data-testid="edge-best-worst"
      >
        <h2 className="text-base font-semibold">Your best and worst combinations</h2>
        {report.bestWorst.needMoreTrades ? (
          <p className="text-sm text-muted-foreground" data-testid="edge-best-worst-thin">
            {NEED_MORE_TRADES} — combinations are only ranked once they reach 30 closed trades, so
            small samples never masquerade as patterns.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {report.bestWorst.best && (
              <ComboCard group={report.bestWorst.best} label="Strongest historical" tone="up" />
            )}
            {report.bestWorst.worst && (
              <ComboCard group={report.bestWorst.worst} label="Weakest historical" tone="down" />
            )}
          </div>
        )}
      </section>

      {/* Pair × session heatmap */}
      <section className="rounded-lg border border-border p-4 space-y-3 overflow-x-auto">
        <h2 className="text-base font-semibold">Heatmap — win rate by pair × session</h2>
        <p className="text-xs text-muted-foreground">
          Cell shows win rate and sample size. Dimmed cells have fewer than 30 trades — hover for
          the exact count.
        </p>
        <table className="w-full text-sm min-w-[640px]" data-testid="edge-heatmap">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Pair</th>
              {sessionKeys.map((s) => (
                <th key={s} className="py-1.5 px-2 font-medium text-center">
                  {SESSION_DEFINITIONS[s]?.label ?? s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair) => (
              <tr key={pair} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono text-xs font-semibold whitespace-nowrap">
                  {pair}
                </td>
                {sessionKeys.map((s) => {
                  const g = cellOf(pair, s);
                  if (!g) {
                    return (
                      <td key={s} className="p-1">
                        <div className="h-11 rounded bg-muted/30" />
                      </td>
                    );
                  }
                  const thin = g.trades < 30;
                  const wr = g.winRate;
                  return (
                    <td key={s} className="p-1">
                      <div
                        className={cn(
                          "h-11 rounded flex flex-col items-center justify-center text-[11px] leading-tight",
                          thin
                            ? "bg-muted text-muted-foreground"
                            : wr >= 0.55
                              ? "bg-profit/20 text-profit"
                              : wr >= 0.45
                                ? "bg-warning/15 text-warning"
                                : "bg-loss/15 text-loss",
                        )}
                        title={`${pair} · ${s}: ${g.trades} trades, ${pct(wr)}% win rate${thin ? " (need more trades)" : ""}`}
                        data-testid={`heatmap-cell-${pair}-${s}`}
                      >
                        <span className="font-bold tabular-nums">{pct(wr)}%</span>
                        <span className="opacity-70">
                          n={g.trades}
                          {thin ? " · thin" : ""}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Full pair × session table */}
      <GroupTable
        title="Results by pair × session"
        testid="edge-table"
        groups={report.byPairSession.map((e) => ({ ...e.group, pair: e.pair, session: e.session }))}
        currency={baseCurrency}
      />

      {/* Pair × hour table */}
      <GroupTable
        title="Results by pair × hour (your timezone)"
        testid="edge-hour-table"
        groups={report.byPairHour}
        currency={baseCurrency}
      />

      {/* Volatility buckets */}
      <GroupTable
        title="Results by volatility at entry"
        testid="edge-vol-table"
        groups={report.byVolatility}
        currency={baseCurrency}
        note="Buckets from the volatility percentile recorded at save time: LOW < 33 · MEDIUM 33–66 · HIGH ≥ 67."
      />

      {/* Plain-language insights */}
      <section className="rounded-lg border border-border p-4 space-y-2" data-testid="edge-insights">
        <h2 className="text-base font-semibold">What your history shows</h2>
        <ul className="space-y-1.5">
          {report.insights.map((i) => (
            <li key={i.id} className="flex items-start gap-2 text-sm" data-testid={`edge-insight-${i.id}`}>
              <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {disclaimer}
    </div>
  );
}

function PageHeader() {
  return (
    <div className="space-y-1.5">
      <Link
        href="/app/analytics"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <ArrowLeft className="size-3" aria-hidden="true" /> Back to Analytics
      </Link>
      <h1 className="text-2xl font-bold tracking-tight">Market edge</h1>
      <p className="text-sm text-muted-foreground">
        How your trades have turned out across market ratings, sessions, hours and volatility —
        grouped with sample size and reliability on every row.
      </p>
    </div>
  );
}

function ComboCard({
  group,
  label,
  tone,
  currency = "USD",
}: {
  group: EdgeGroup;
  label: string;
  tone: "up" | "down";
  currency?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 space-y-1",
        tone === "up" ? "border-profit/30 bg-profit/5" : "border-loss/30 bg-loss/5",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <ReliabilityTag rating={group.reliability} />
      </div>
      <div className="text-sm font-semibold font-mono">{group.key}</div>
      <div className="text-xs text-muted-foreground">
        {group.trades} trades · {pct(group.winRate)}% win rate{" "}
        {group.reliability !== "INSUFFICIENT" && (
          <>
            (range {pct(group.winRateLow)}–{pct(group.winRateHigh)}%)
          </>
        )}
      </div>
      <div className="text-sm tabular-nums">
        {group.expectancy >= 0 ? "+" : ""}
        {formatMoney(group.expectancy, currency, { signed: true })} per trade
      </div>
    </div>
  );
}

function GroupTable({
  title,
  testid,
  groups,
  currency,
  note,
}: {
  title: string;
  testid: string;
  groups: Array<
    EdgeGroup & { pair?: string; session?: string }
  >;
  currency: string;
  note?: string;
}) {
  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]" data-testid={testid}>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Group</th>
              <th className="py-1.5 px-2 font-medium text-right">Trades</th>
              <th className="py-1.5 px-2 font-medium text-right">Win rate</th>
              <th className="py-1.5 px-2 font-medium">Confidence</th>
              <th className="py-1.5 px-2 font-medium text-right">Expectancy</th>
              <th className="py-1.5 px-2 font-medium text-right">Net P/L</th>
              <th className="py-1.5 pl-2 font-medium">Reliability</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-t border-border" data-testid={`edge-row-${g.key}`}>
                <td className="py-2 pr-3">
                  <div className="font-medium text-xs font-mono">{g.key}</div>
                  {g.reliability === "INSUFFICIENT" && (
                    <div className="text-[10px] text-muted-foreground">{NEED_MORE_TRADES}</div>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular-nums">{g.trades}</td>
                <td className="py-2 px-2 text-right tabular-nums font-medium">{pct(g.winRate)}%</td>
                <td className="py-2 px-2 text-xs tabular-nums text-muted-foreground">
                  {g.reliability === "INSUFFICIENT"
                    ? "—"
                    : `${pct(g.winRateLow)}–${pct(g.winRateHigh)}%`}
                </td>
                <td
                  className={cn(
                    "py-2 px-2 text-right tabular-nums",
                    g.expectancy > 0 ? "text-profit" : g.expectancy < 0 ? "text-loss" : "",
                  )}
                >
                  {g.expectancy >= 0 ? "+" : ""}
                  {formatMoney(g.expectancy, currency, { signed: true })}
                </td>
                <td
                  className={cn(
                    "py-2 px-2 text-right tabular-nums",
                    g.totalPnl > 0 ? "text-profit" : g.totalPnl < 0 ? "text-loss" : "",
                  )}
                >
                  {g.totalPnl >= 0 ? "+" : ""}
                  {formatMoney(g.totalPnl, currency, { signed: true })}
                </td>
                <td className="py-2 pl-2">
                  <ReliabilityTag rating={g.reliability} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
