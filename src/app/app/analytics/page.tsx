import { BarChart3, TrendingUp, TrendingDown, Calculator } from "lucide-react";
import Link from "next/link";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getAnalytics, type AnalyticsFilter } from "@/server/lib/analytics";
import { db } from "@/lib/db";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { TiltHistoryCard } from "@/components/analytics/TiltHistoryCard";
import {
  EquityCurveChart,
  DrawdownChart,
  WinRateBreakdown,
  InsightsPanel,
  PeriodComparison,
} from "@/components/analytics/Charts";
import { MoneyText } from "@/components/trader/MoneyText";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatPercent, formatDate } from "@/lib/format";
import { startOfTodayUtc, startOfWeekUtc } from "@/lib/timezone";
import Decimal from "decimal.js";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    accountId?: string;
    strategyId?: string;
  }>;
}) {
  const { userId, timezone } = await requireUser();
  const sp = await searchParams;

  // Parse filters.
  const dateFrom = sp.from ? new Date(sp.from) : null;
  const dateTo = sp.to ? new Date(sp.to) : null;
  const tradingAccountId = sp.accountId || null;
  const strategyId = sp.strategyId || null;

  // Fetch accounts + strategies for filter dropdowns.
  const accounts = await listUserAccounts();
  const strategies = await db.strategy.findMany({
    where: { userId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const filter: AnalyticsFilter = {
    userId,
    tradingAccountId: tradingAccountId ?? undefined,
    strategyId: strategyId ?? undefined,
    dateFrom: dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom : null,
    dateTo: dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo : null,
  };

  const result = await getAnalytics(filter);

  // Phase 16: fetch tilt history for the tilt card.
  const tiltEvents = await db.tiltEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { score: true, level: true, createdAt: true },
  });

  // Compute P/L for trades taken while tilted (within 15 min of a TILT event)
  // vs calm (all other trades). Query the same trades the analytics uses.
  const tiltEventInstants = tiltEvents
    .filter((e) => e.level === "TILT")
    .map((e) => e.createdAt.getTime());

  const periodTrades = await db.trade.findMany({
    where: {
      userId,
      ...(tradingAccountId ? { tradingAccountId } : {}),
      result: { in: ["WIN", "LOSS", "TIE"] },
      ...(dateFrom || dateTo
        ? {
            openedAt: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1) } : {}),
            },
          }
        : {}),
    },
    select: { profitLoss: true, openedAt: true },
    take: 5000,
  });

  let tiltPL = 0;
  let calmPL = 0;
  for (const t of periodTrades) {
    const tMs = t.openedAt.getTime();
    const isTilted = tiltEventInstants.some((teMs) => tMs >= teMs && tMs <= teMs + 15 * 60 * 1000);
    const pl = Number(t.profitLoss.toString());
    if (isTilted) tiltPL += pl;
    else calmPL += pl;
  }

  const tiltHistory = {
    totalEvents: tiltEvents.length,
    tiltEvents: tiltEvents.map((e) => ({
      score: Number(e.score.toString()),
      level: e.level,
      createdAt: e.createdAt.toISOString(),
    })),
    tiltPL,
    calmPL,
  };

  if (result.counts.total === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">No trades match these filters.</p>
        </div>
        <FilterBar
          accounts={accounts}
          strategies={strategies}
          currentFrom={sp.from}
          currentTo={sp.to}
          currentAccountId={tradingAccountId ?? ""}
          currentStrategyId={strategyId ?? ""}
        />
        <EmptyState
          icon={BarChart3}
          title="No trades to analyze"
          description="Try widening your date range or clearing filters. Add trades from the Trades page."
          actionLabel="Go to Trades"
          actionHref="/app/trades"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {result.counts.total} trades · {result.counts.wins}W / {result.counts.losses}L /{" "}
            {result.counts.ties}T
          </p>
        </div>
        <Link
          href="/app/analytics/market-edge"
          className="text-sm text-primary hover:underline"
          data-testid="market-edge-link"
        >
          Market edge (by rating & session) →
        </Link>
      </div>

      {/* Filter bar */}
      <FilterBar
        accounts={accounts}
        strategies={strategies}
        currentFrom={sp.from}
        currentTo={sp.to}
        currentAccountId={tradingAccountId ?? ""}
        currentStrategyId={strategyId ?? ""}
      />

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          label="Net P/L"
          value={formatMoney(result.netProfit, "USD", { signed: true })}
          trend={result.netProfit > 0 ? "up" : result.netProfit < 0 ? "down" : "neutral"}
          icon={result.netProfit >= 0 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Win rate"
          value={formatPercent(result.winRate, { alreadyPercent: false, decimals: 1 })}
          delta={`Break-even: ${formatPercent(result.breakEvenWinRate, { alreadyPercent: false, decimals: 1 })}`}
          icon={BarChart3}
        />
        <StatCard
          label="Profit factor"
          value={Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞"}
          delta={result.profitFactor >= 1 ? "Profitable" : "Below break-even"}
          trend={result.profitFactor >= 1 ? "up" : "down"}
          icon={Calculator}
        />
        <StatCard
          label="Expectancy/trade"
          value={formatMoney(result.expectancyPerTrade, "USD", { signed: true })}
          trend={result.expectancyPerTrade > 0 ? "up" : "down"}
          icon={TrendingUp}
        />
        <StatCard label="Avg win" value={formatMoney(result.averageWin, "USD")} icon={TrendingUp} />
        <StatCard
          label="Avg loss"
          value={formatMoney(result.averageLoss, "USD")}
          icon={TrendingDown}
        />
        <StatCard
          label="Payoff ratio"
          value={Number.isFinite(result.payoffRatio) ? result.payoffRatio.toFixed(2) : "∞"}
          icon={Calculator}
        />
        <StatCard
          label="Recovery factor"
          value={Number.isFinite(result.recoveryFactor) ? result.recoveryFactor.toFixed(2) : "∞"}
          icon={BarChart3}
        />
      </div>

      {/* Equity curve + drawdown */}
      <div className="rounded-lg border border-border p-4 space-y-4">
        <h2 className="text-base font-semibold">Equity curve</h2>
        <EquityCurveChart data={result.equityCurve} height={300} />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-sm font-semibold mb-2">Max drawdown</h3>
            <div className="text-2xl font-bold tabular-nums text-loss">
              -{formatMoney(result.drawdown.maxDrawdown, "USD")}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(result.drawdown.maxDrawdownPercent, {
                alreadyPercent: false,
                decimals: 1,
              })}{" "}
              of peak
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-2">Current drawdown</h3>
            <div className="text-2xl font-bold tabular-nums text-loss">
              -{formatMoney(result.drawdown.currentDrawdown, "USD")}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(result.drawdown.currentDrawdownPercent, {
                alreadyPercent: false,
                decimals: 1,
              })}{" "}
              of peak
            </div>
          </div>
        </div>
      </div>

      {/* Streak statistics */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Longest win streak"
          value={result.streaks.longestWinStreak}
          icon={TrendingUp}
        />
        <StatCard
          label="Longest loss streak"
          value={result.streaks.longestLossStreak}
          icon={TrendingDown}
        />
        <StatCard
          label="Current streak"
          value={
            result.streaks.currentStreak > 0
              ? `${result.streaks.currentStreak}W`
              : result.streaks.currentStreak < 0
                ? `${Math.abs(result.streaks.currentStreak)}L`
                : "—"
          }
          icon={BarChart3}
        />
      </div>

      {/* Insights panel */}
      <InsightsPanel insights={result.insights} />

      {/* Period comparison */}
      {result.periodComparison && <PeriodComparison data={result.periodComparison} />}

      {/* Followed-plan vs broke-plan comparison */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-3">Followed plan vs broke plan</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-md border border-profit/30 bg-profit/5 p-3">
            <div className="text-xs text-profit font-medium">
              Followed plan ({result.followedPlanComparison.followedCount})
            </div>
            <div className="text-xl font-bold tabular-nums">
              {formatPercent(result.followedPlanComparison.followedWinRate, {
                alreadyPercent: false,
                decimals: 1,
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              Net:{" "}
              {formatMoney(result.followedPlanComparison.followedNetPL, "USD", { signed: true })}
            </div>
          </div>
          <div className="rounded-md border border-loss/30 bg-loss/5 p-3">
            <div className="text-xs text-loss font-medium">
              Broke plan ({result.followedPlanComparison.brokeCount})
            </div>
            <div className="text-xl font-bold tabular-nums">
              {formatPercent(result.followedPlanComparison.brokeWinRate, {
                alreadyPercent: false,
                decimals: 1,
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              Net: {formatMoney(result.followedPlanComparison.brokeNetPL, "USD", { signed: true })}
            </div>
          </div>
        </div>
      </div>

      {/* Win rate breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WinRateBreakdown title="Win rate by asset" data={result.winRateByAsset} />
        <WinRateBreakdown title="Win rate by strategy" data={result.winRateByStrategy} />
        <WinRateBreakdown title="Win rate by hour (UTC)" data={result.winRateByHour} />
        <WinRateBreakdown title="Win rate by weekday" data={result.winRateByWeekday} />
        <WinRateBreakdown title="Win rate by emotion" data={result.winRateByEmotion} />
        <WinRateBreakdown title="CALL vs PUT" data={result.winRateByDirection} />
      </div>

      {/* Best/worst assets */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Best asset"
          value={result.bestAsset?.key ?? "—"}
          delta={
            result.bestAsset
              ? `${(result.bestAsset.winRate * 100).toFixed(0)}% WR · ${result.bestAsset.count} trades`
              : undefined
          }
          trend="up"
          icon={TrendingUp}
        />
        <StatCard
          label="Worst asset"
          value={result.worstAsset?.key ?? "—"}
          delta={
            result.worstAsset
              ? `${(result.worstAsset.winRate * 100).toFixed(0)}% WR · ${result.worstAsset.count} trades`
              : undefined
          }
          trend="down"
          icon={TrendingDown}
        />
      </div>

      {/* Stake-size distribution */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-3">Stake-size distribution</h3>
        <div className="space-y-1">
          {result.stakeDistribution.map((bin, i) => {
            const max = Math.max(...result.stakeDistribution.map((b) => b.count), 1);
            const pct = (bin.count / max) * 100;
            return (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-24 font-mono text-muted-foreground">{bin.range}</span>
                <div className="flex-1 h-4 rounded-sm bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <span className="w-8 text-right tabular-nums">{bin.count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Phase 16: Tilt history card */}
      <TiltHistoryCard data={tiltHistory} />
    </div>
  );
}

/**
 * Server-rendered filter bar — GET parameters form (no JS needed).
 */
function FilterBar({
  accounts,
  strategies,
  currentFrom,
  currentTo,
  currentAccountId,
  currentStrategyId,
}: {
  accounts: { id: string; name: string }[];
  strategies: { id: string; name: string }[];
  currentFrom: string | undefined;
  currentTo: string | undefined;
  currentAccountId: string;
  currentStrategyId: string;
}) {
  return (
    <form className="rounded-lg border border-border p-3 flex flex-wrap gap-2" method="GET">
      <label className="text-xs text-muted-foreground self-center">From:</label>
      <input
        type="date"
        name="from"
        defaultValue={currentFrom}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      />
      <label className="text-xs text-muted-foreground self-center">To:</label>
      <input
        type="date"
        name="to"
        defaultValue={currentTo}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      />
      <select
        name="accountId"
        defaultValue={currentAccountId}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <select
        name="strategyId"
        defaultValue={currentStrategyId}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">All strategies</option>
        {strategies.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium"
      >
        Apply
      </button>
      <a
        href="/app/analytics"
        className="h-9 px-4 rounded-md border border-input bg-background text-sm hover:bg-accent inline-flex items-center"
      >
        Clear
      </a>
    </form>
  );
}
