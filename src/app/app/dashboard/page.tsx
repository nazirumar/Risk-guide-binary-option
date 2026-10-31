import { TrendingUp, BookOpen, Wallet, BarChart3, TrendingDown, ShieldX, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { RiskMeter } from "@/components/risk/RiskMeter";
import { EquityCurveChart } from "@/components/analytics/Charts";
import { BalanceCheckPromptBanner } from "@/components/balance-sync/BalanceCheckPromptBanner";
import { BigWinDayPromptBanner } from "@/components/withdrawal/BigWinDayPromptBanner";
import { BankedVsAtRiskCard } from "@/components/withdrawal/BankedVsAtRiskCard";
import { DisciplineScoreCard } from "@/components/discipline/DisciplineScoreCard";
import { MarketNowWidget } from "@/components/market/MarketNowWidget";
import { DailyGoalTracker } from "@/components/goals/DailyGoalTracker";
import { PayoutCalculator } from "@/components/trades/PayoutCalculator";
import { RiskPositionSizer } from "@/components/trades/RiskPositionSizer";
import { TradingStreak } from "@/components/dashboard/TradingStreak";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getDashboardStats } from "@/server/lib/analytics";
import { getActiveLockout } from "@/server/lib/risk-check";
import { db } from "@/lib/db";
import { formatMoney, formatPercent, formatDate } from "@/lib/format";
import { startOfTodayUtc } from "@/lib/timezone";
import Decimal from "decimal.js";
import { MoneyText } from "@/components/trader/MoneyText";
import { Skeleton } from "@/components/ui/skeleton";

export default async function DashboardPage() {
  const { userId, baseCurrency, timezone } = await requireUser();
  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();

  if (!activeAccount) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <Link href="/app/trades">
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              New Trade
            </Button>
          </Link>
        </div>
        <EmptyState
          icon={Wallet}
          title="No trading account yet"
          description="Add your first broker account from the Accounts page to start tracking trades."
          actionLabel="Add account"
          actionHref="/app/accounts"
        />
      </div>
    );
  }

  // Fetch dashboard stats (React cache() prevents duplicate queries in same render).
  const [stats, riskProfile, recentTradesForStreak, openTradesCount, activeLockout, avoided] =
    await Promise.all([
      getDashboardStats(
        userId,
        timezone,
        activeAccount.id,
        activeAccount.currentBalance,
        activeAccount.currency,
      ),
      db.riskProfile.findFirst({
        where: { userId, tradingAccountId: activeAccount.id },
      }) ??
        db.riskProfile.findFirst({
          where: { userId, tradingAccountId: null },
          orderBy: { createdAt: "desc" },
        }),
      db.trade.findMany({
        where: {
          userId,
          tradingAccountId: activeAccount.id,
          result: { in: ["WIN", "LOSS", "TIE"] },
        },
        orderBy: { closedAt: "desc" },
        take: 50,
        select: { result: true },
      }),
      db.trade.count({
        where: { userId, tradingAccountId: activeAccount.id, result: "OPEN" },
      }),
      getActiveLockout(userId),
      // Phase 17: cancelled pre-trade confirmations — "trades you avoided".
      db.cancelledTradeAttempt.aggregate({
        where: { userId },
        _count: { _all: true },
        _sum: { stake: true },
      }),
    ]);

  // Compute loss streak.
  let currentLossStreak = 0;
  for (const t of recentTradesForStreak) {
    if (t.result === "LOSS") currentLossStreak++;
    else break;
  }

  // Format equity curve data.
  const equityData = stats.equityCurve.map((d) => ({ date: d.date, balance: d.balance }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {activeAccount.name} ({activeAccount.broker}) · {activeAccount.currency}
            {activeLockout && <span className="ml-2 text-warning font-medium">· Trading locked</span>}
          </p>
        </div>
        <Link href="/app/trades">
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            New Trade
          </Button>
        </Link>
      </div>

      {/* Phase 18 — daily broker-balance reminder banner (client-rendered to
          avoid a hydration flash; the banner hides itself if reminders are
          OFF or the user has already been prompted today). */}
      <BalanceCheckPromptBanner activeAccount={activeAccount} />

      {/* Phase 19 — big-win-day prompt (client-rendered, hides itself when
          disabled or already prompted today). */}
      <BigWinDayPromptBanner />

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          label="Balance"
          value={formatMoney(stats.balance, stats.currency)}
          icon={Wallet}
        />
        <StatCard
          label="Today P/L"
          value={formatMoney(stats.todayPL, stats.currency, { signed: true })}
          delta={`${stats.todayTrades} trade${stats.todayTrades === 1 ? "" : "s"} today`}
          trend={Number(stats.todayPL) > 0 ? "up" : Number(stats.todayPL) < 0 ? "down" : "neutral"}
          icon={Number(stats.todayPL) >= 0 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Week P/L"
          value={formatMoney(stats.weekPL, stats.currency, { signed: true })}
          delta={`${stats.weekTrades} trade${stats.weekTrades === 1 ? "" : "s"} this week`}
          trend={Number(stats.weekPL) > 0 ? "up" : Number(stats.weekPL) < 0 ? "down" : "neutral"}
          icon={Number(stats.weekPL) >= 0 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Month P/L"
          value={formatMoney(stats.monthPL, stats.currency, { signed: true })}
          delta={`${stats.monthTrades} trade${stats.monthTrades === 1 ? "" : "s"} this month`}
          trend={Number(stats.monthPL) > 0 ? "up" : Number(stats.monthPL) < 0 ? "down" : "neutral"}
          icon={Number(stats.monthPL) >= 0 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Win rate"
          value={formatPercent(stats.winRate, { alreadyPercent: false, decimals: 1 })}
          delta={`${Math.round(stats.winRate * stats.totalTrades)}W / ${stats.totalTrades - Math.round(stats.winRate * stats.totalTrades)}L`}
          icon={BarChart3}
        />
        <StatCard
          label="Profit factor"
          value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"}
          delta={stats.profitFactor >= 1 ? "Profitable" : "Below break-even"}
          trend={stats.profitFactor >= 1 ? "up" : "down"}
          icon={BarChart3}
        />
        <StatCard
          label="Current streak"
          value={
            stats.currentStreak > 0
              ? `${stats.currentStreak}W`
              : stats.currentStreak < 0
                ? `${Math.abs(stats.currentStreak)}L`
                : "—"
          }
          delta={`Best: ${stats.longestWinStreak}W / Worst: ${stats.longestLossStreak}L`}
          icon={BookOpen}
        />
        <StatCard
          label="Total trades"
          value={stats.totalTrades}
          delta={`Expectancy: ${stats.expectancy}/trade`}
          icon={BookOpen}
        />
      </div>

      {/* Equity curve mini chart */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold">Equity curve</h2>
          <Link href="/app/analytics" className="text-xs text-primary hover:underline">
            View full analytics →
          </Link>
        </div>
        {equityData.length > 0 ? (
          <EquityCurveChart data={equityData} height={250} />
        ) : (
          <EmptyState
            icon={BookOpen}
            title="No trades yet"
            description="Your equity curve will start forming as soon as you add trades."
            actionLabel="Add trade"
            actionHref="/app/trades"
          />
        )}
      </div>

      {/* Phase 19 — Banked profit vs at-risk capital (links to /app/withdrawal) */}
      <BankedVsAtRiskCard />

      {/* Phase 21 — Daily discipline score + streak (links to /app/discipline) */}
      <DisciplineScoreCard />

      {/* Phase 28 — "Market now" widget: top 3 pairs + next high-impact news */}
      <MarketNowWidget />

      <DailyGoalTracker goalAmount={100} currentAmount={Number((stats as any).todayPL?.toString() || 0) > 0 ? Number((stats as any).todayPL?.toString() || 0) : 0} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <TradingStreak currentStreak={currentLossStreak === 0 ? 0 : 0} bestStreak={0} />
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Quick Tools</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PayoutCalculator />
          <RiskPositionSizer />
        </div>
      </div>

      {/* Risk meter */}
      {riskProfile && (
        <RiskMeter
          data={{
            balance: activeAccount.currentBalance,
            currency: activeAccount.currency,
            dailyPL: stats.todayPL,
            maxDailyLossPercent: riskProfile.maxDailyLossPercent?.toString() ?? null,
            maxDailyLossAmount: riskProfile.maxDailyLossAmount?.toString() ?? null,
            tradesToday: stats.todayTrades,
            maxTradesPerDay: riskProfile.maxTradesPerDay,
            openTrades: openTradesCount,
            maxOpenTrades: riskProfile.maxOpenTrades,
            currentLossStreak,
            maxConsecutiveLosses: riskProfile.maxConsecutiveLosses,
            dailyProfitTargetPercent: riskProfile.dailyProfitTargetPercent?.toString() ?? null,
          }}
        />
      )}

      {/* Trades you avoided (Phase 17) */}
      {avoided._count._all > 0 && (
        <div
          className="rounded-lg border border-profit/30 bg-profit/5 px-4 py-3 flex items-center justify-between gap-4"
          data-testid="trades-you-avoided"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-full bg-profit/15 p-2 shrink-0">
              <ShieldX className="size-5 text-profit" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Trades you avoided</h2>
              <p className="text-xs text-muted-foreground">
                Cancelled at the pre-trade confirmation screen. Discipline is money kept.
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold tabular-nums" data-testid="avoided-count">
              {avoided._count._all}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatMoney(avoided._sum.stake?.toString() ?? "0", activeAccount.currency)} not
              risked
            </div>
          </div>
        </div>
      )}

      {/* Last 10 trades */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Last 10 trades</h2>
        </div>
        {stats.lastTrades.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={BookOpen}
              title="No trades yet"
              description="Your trade journal is empty. Add your first trade to start tracking."
              actionLabel="Add trade"
              actionHref="/app/trades"
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {stats.lastTrades.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`text-xs font-bold px-1.5 py-0.5 rounded ${t.direction === "CALL" ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss"}`}
                  >
                    {t.direction}
                  </span>
                  <span className="font-mono text-sm truncate">{t.asset}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(t.openedAt, { withTime: true })}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs font-medium ${t.result === "WIN" ? "text-profit" : t.result === "LOSS" ? "text-loss" : "text-muted-foreground"}`}
                  >
                    {t.result}
                  </span>
                  <MoneyText amount={t.profitLoss} currency={stats.currency} signed />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
