/**
 * Phase 9 — Server-side analytics aggregation helpers.
 *
 * These functions fetch trades from the DB (scoped by userId + optional
 * date range + account/strategy filter) and compute analytics using the
 * Phase 6 calc engine (`@/lib/calc/*`). The results are plain JSON-safe
 * objects (all Decimal fields stringified) so they can cross the
 * server→client boundary without serialization issues.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 */

import { cache } from "react";
import { db } from "@/lib/db";
import {
  computeStats,
  winRate,
  lossRate,
  tieRate,
  expectancyPerTrade,
  profitFactor,
  averageWin,
  averageLoss,
  netProfit,
  grossProfit,
  grossLoss,
} from "@/lib/calc/rates";
import {
  equityCurve,
  drawdownStats,
  computeStreaks,
  recoveryFactor,
  computeEquityStats,
} from "@/lib/calc/equity";
import {
  groupAndAggregate,
  groupByAsset,
  groupByHourOfDay,
  groupByDayOfWeek,
  groupByStrategy,
  groupByEmotion,
  groupByDirection,
  type GroupStat,
} from "@/lib/calc/group-by";
import type { TradeLike, NormalizedTrade } from "@/lib/calc/types";
import { normalizeTrades } from "@/lib/calc/normalize";
import Decimal from "decimal.js";
import { startOfTodayUtc, startOfWeekUtc } from "@/lib/timezone";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AnalyticsFilter = {
  userId: string;
  tradingAccountId?: string | null;
  strategyId?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
};

export type DashboardStats = {
  balance: string;
  currency: string;
  todayPL: string;
  weekPL: string;
  monthPL: string;
  winRate: number;
  totalTrades: number;
  todayTrades: number;
  weekTrades: number;
  monthTrades: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  profitFactor: number;
  expectancy: string;
  equityCurve: { date: string; balance: number }[];
  lastTrades: {
    id: string;
    asset: string;
    direction: string;
    result: string;
    profitLoss: string;
    openedAt: string;
    stake: string;
  }[];
};

export type AnalyticsResult = {
  counts: { total: number; wins: number; losses: number; ties: number };
  winRate: number;
  lossRate: number;
  tieRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  profitFactor: number;
  expectancyPerTrade: number;
  averagePayout: number;
  breakEvenWinRate: number;
  equityCurve: { date: string; balance: number }[];
  drawdown: {
    maxDrawdown: number;
    maxDrawdownPercent: number;
    currentDrawdown: number;
    currentDrawdownPercent: number;
  };
  recoveryFactor: number;
  streaks: {
    longestWinStreak: number;
    longestLossStreak: number;
    currentStreak: number;
  };
  bestAsset: GroupStat | null;
  worstAsset: GroupStat | null;
  winRateByAsset: GroupStat[];
  winRateByHour: GroupStat[];
  winRateByWeekday: GroupStat[];
  winRateByStrategy: GroupStat[];
  winRateByEmotion: GroupStat[];
  winRateByDirection: GroupStat[];
  followedPlanComparison: {
    followedCount: number;
    followedWinRate: number;
    followedNetPL: number;
    brokeCount: number;
    brokeWinRate: number;
    brokeNetPL: number;
  };
  stakeDistribution: { range: string; count: number }[];
  insights: string[];
  periodComparison: {
    current: { netPL: number; winRate: number; trades: number };
    previous: { netPL: number; winRate: number; trades: number };
    delta: { netPL: number; winRate: number; trades: number };
  } | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function toTradeLike(row: {
  profitLoss: Decimal;
  result: string;
  stake: Decimal;
  payoutPercent: Decimal;
  openedAt: Date;
  asset: string;
  strategy?: string | null;
  emotion?: string | null;
  direction: string;
}): TradeLike {
  return {
    profitLoss: row.profitLoss.toString(),
    result: row.result as TradeLike["result"],
    stake: row.stake.toString(),
    payoutPercent: row.payoutPercent.toString(),
    openedAt: row.openedAt,
    asset: row.asset,
    strategy: row.strategy,
    emotion: row.emotion,
    direction: row.direction as TradeLike["direction"],
  };
}

function buildWhereClause(filter: AnalyticsFilter) {
  const where: Record<string, unknown> = {
    userId: filter.userId,
    result: { in: ["WIN", "LOSS", "TIE"] },
  };
  if (filter.tradingAccountId) where.tradingAccountId = filter.tradingAccountId;
  if (filter.dateFrom || filter.dateTo) {
    where.openedAt = {};
    if (filter.dateFrom) (where.openedAt as Record<string, unknown>).gte = filter.dateFrom;
    if (filter.dateTo) {
      const end = new Date(filter.dateTo);
      end.setUTCHours(23, 59, 59, 999);
      (where.openedAt as Record<string, unknown>).lte = end;
    }
  }
  if (filter.strategyId) {
    // Need to match by strategy name since we denormalized.
    // We'll handle this in JS after fetch.
  }
  return where;
}

// ─── Dashboard stats (per-request cached via React cache()) ────────────────

/**
 * Fetch dashboard stats for a user. Cached per-request via React's `cache()`
 * so multiple components in the same render don't duplicate the query.
 */
export const getDashboardStats = cache(
  async (
    userId: string,
    timezone: string,
    activeAccountId: string | null,
    activeAccountBalance: string,
    activeAccountCurrency: string,
  ): Promise<DashboardStats> => {
    const now = new Date();
    const startToday = startOfTodayUtc(timezone, now);
    const startWeek = startOfWeekUtc(timezone, now);
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const accountFilter = activeAccountId ? { tradingAccountId: activeAccountId } : {};

    // Fetch all closed trades for the active account (for equity curve + streaks).
    const allTrades = await db.trade.findMany({
      where: { userId, ...accountFilter, result: { in: ["WIN", "LOSS", "TIE"] } },
      orderBy: { openedAt: "asc" },
      select: {
        id: true,
        profitLoss: true,
        result: true,
        stake: true,
        payoutPercent: true,
        openedAt: true,
        asset: true,
        direction: true,
        strategy: { select: { name: true } },
        emotion: true,
        followedPlan: true,
      },
      take: 5000, // cap for performance
    });

    const tradeLike = allTrades.map((t) => ({
      profitLoss: t.profitLoss.toString(),
      result: t.result,
      stake: t.stake.toString(),
      payoutPercent: t.payoutPercent.toString(),
      openedAt: t.openedAt,
      asset: t.asset,
      direction: t.direction,
      strategy: t.strategy?.name ?? null,
      emotion: t.emotion,
    }));

    // Compute stats using the Phase 6 calc engine.
    const normalized = normalizeTrades(tradeLike);
    const stats = computeStats(tradeLike);
    const equityStats = computeEquityStats(tradeLike, Number(activeAccountBalance));
    const streaks = equityStats.streaks;

    // Today/week/month P/L.
    const todayPL = normalized
      .filter((t) => t.openedAt >= startToday)
      .reduce((acc, t) => acc + t.profitLoss, 0);
    const weekPL = normalized
      .filter((t) => t.openedAt >= startWeek)
      .reduce((acc, t) => acc + t.profitLoss, 0);
    const monthPL = normalized
      .filter((t) => t.openedAt >= startMonth)
      .reduce((acc, t) => acc + t.profitLoss, 0);

    const todayTrades = normalized.filter((t) => t.openedAt >= startToday).length;
    const weekTrades = normalized.filter((t) => t.openedAt >= startWeek).length;
    const monthTrades = normalized.filter((t) => t.openedAt >= startMonth).length;

    // Equity curve for the chart (limit to last 100 points for the dashboard mini-chart).
    const equity = equityStats.equity;
    const equityCurveData = allTrades
      .map((t, i) => ({
        date: t.openedAt.toISOString(),
        balance: equity[i + 1] ?? Number(activeAccountBalance),
      }))
      .slice(-100); // last 100 for the mini-chart

    // Last 10 trades.
    const lastTrades = allTrades
      .slice(-10)
      .reverse()
      .map((t) => ({
        id: t.id,
        asset: t.asset,
        direction: t.direction,
        result: t.result,
        profitLoss: t.profitLoss.toString(),
        openedAt: t.openedAt.toISOString(),
        stake: t.stake.toString(),
      }));

    return {
      balance: activeAccountBalance,
      currency: activeAccountCurrency,
      todayPL: new Decimal(todayPL).toFixed(2),
      weekPL: new Decimal(weekPL).toFixed(2),
      monthPL: new Decimal(monthPL).toFixed(2),
      winRate: stats.winRate,
      totalTrades: normalized.length,
      todayTrades,
      weekTrades,
      monthTrades,
      currentStreak: streaks.currentStreak,
      longestWinStreak: streaks.longestWinStreak,
      longestLossStreak: streaks.longestLossStreak,
      profitFactor: stats.profitFactor,
      expectancy: new Decimal(stats.expectancyPerTrade).toFixed(2),
      equityCurve: equityCurveData,
      lastTrades,
    };
  },
);

// ─── Full analytics (for the analytics page) ──────────────────────────────

export async function getAnalytics(filter: AnalyticsFilter): Promise<AnalyticsResult> {
  const where = buildWhereClause(filter);

  const rawTrades = await db.trade.findMany({
    where,
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      profitLoss: true,
      result: true,
      stake: true,
      payoutPercent: true,
      openedAt: true,
      asset: true,
      direction: true,
      strategy: { select: { name: true } },
      emotion: true,
      followedPlan: true,
    },
    take: 5000,
  });

  // Strategy filter (if provided, filter in JS since we join by name).
  let filteredTrades = rawTrades;
  if (filter.strategyId) {
    const strategy = await db.strategy.findUnique({
      where: { id: filter.strategyId },
      select: { name: true },
    });
    if (strategy) {
      filteredTrades = rawTrades.filter((t) => t.strategy?.name === strategy.name);
    }
  }

  const tradeLike: TradeLike[] = filteredTrades.map((t) => ({
    profitLoss: t.profitLoss.toString(),
    result: t.result,
    stake: t.stake.toString(),
    payoutPercent: t.payoutPercent.toString(),
    openedAt: t.openedAt,
    asset: t.asset,
    direction: t.direction,
    strategy: t.strategy?.name ?? null,
    emotion: t.emotion,
  }));

  const normalized = normalizeTrades(tradeLike);
  const stats = computeStats(tradeLike);

  // Equity curve.
  const startingBalance = 0; // Analytics equity curve starts from 0 (cumulative P/L).
  const equity = equityCurve(normalized, startingBalance);
  const dd = drawdownStats(equity);
  const streaks = computeStreaks(normalized);
  const np = normalized.reduce((acc, t) => acc + t.profitLoss, 0);

  const equityCurveData = normalized.map((t, i) => ({
    date: t.openedAt.toISOString(),
    balance: equity[i + 1],
  }));

  // Group breakdowns.
  const ratesModule = { winRate, expectancyPerTrade };
  const byAsset = groupAndAggregate(normalized, groupByAsset, ratesModule);
  const byHour = groupAndAggregate(normalized, groupByHourOfDay, ratesModule);
  const byWeekday = groupAndAggregate(normalized, groupByDayOfWeek, ratesModule);
  const byStrategy = groupAndAggregate(normalized, groupByStrategy, ratesModule);
  const byEmotion = groupAndAggregate(normalized, groupByEmotion, ratesModule);
  const byDirection = groupAndAggregate(normalized, groupByDirection, ratesModule);

  // Followed-plan vs broke-plan.
  const followed = normalized.filter(
    (t) => (t as unknown as { followedPlan?: boolean }).followedPlan !== false,
  );
  // Actually followedPlan isn't in NormalizedTrade — let me compute from raw.
  const followedRaw = filteredTrades.filter((t) => t.followedPlan);
  const brokeRaw = filteredTrades.filter((t) => !t.followedPlan);
  const followedWinRate =
    followedRaw.length > 0
      ? followedRaw.filter((t) => t.result === "WIN").length / followedRaw.length
      : 0;
  const brokeWinRate =
    brokeRaw.length > 0 ? brokeRaw.filter((t) => t.result === "WIN").length / brokeRaw.length : 0;
  const followedNetPL = followedRaw.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
  const brokeNetPL = brokeRaw.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);

  // Stake distribution (5 bins from 0 to max stake).
  const maxStake = normalized.length > 0 ? Math.max(...normalized.map((t) => t.stake)) : 0;
  const stakeBins = 5;
  const binWidth = maxStake > 0 ? maxStake / stakeBins : 1;
  const stakeDistribution = Array.from({ length: stakeBins }, (_, i) => {
    const lo = i * binWidth;
    const hi = i === stakeBins - 1 ? maxStake : (i + 1) * binWidth;
    const count = normalized.filter(
      (t) => t.stake >= lo && (i === stakeBins - 1 ? t.stake <= hi : t.stake < hi),
    ).length;
    return { range: `${lo.toFixed(0)}–${hi.toFixed(0)}`, count };
  });

  // Insights (rule-based plain-language findings).
  const insights = computeInsights(normalized, byEmotion, byDirection, byHour);

  // Period comparison (if date range is set, compare with the same-length previous period).
  let periodComparison: AnalyticsResult["periodComparison"] = null;
  if (filter.dateFrom && filter.dateTo) {
    const rangeMs = filter.dateTo.getTime() - filter.dateFrom.getTime();
    const prevFrom = new Date(filter.dateFrom.getTime() - rangeMs);
    const prevTo = new Date(filter.dateFrom.getTime() - 1);
    const prevTrades = await db.trade.findMany({
      where: {
        userId: filter.userId,
        ...(filter.tradingAccountId ? { tradingAccountId: filter.tradingAccountId } : {}),
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: prevFrom, lte: prevTo },
      },
      select: { profitLoss: true, result: true },
    });
    const prevNP = prevTrades.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
    const prevWins = prevTrades.filter((t) => t.result === "WIN").length;
    const prevWR = prevTrades.length > 0 ? prevWins / prevTrades.length : 0;
    const currNP = np;
    const currWR = stats.winRate;
    periodComparison = {
      current: { netPL: currNP, winRate: currWR, trades: normalized.length },
      previous: { netPL: prevNP, winRate: prevWR, trades: prevTrades.length },
      delta: {
        netPL: currNP - prevNP,
        winRate: currWR - prevWR,
        trades: normalized.length - prevTrades.length,
      },
    };
  }

  return {
    counts: stats.counts,
    winRate: stats.winRate,
    lossRate: stats.lossRate,
    tieRate: stats.tieRate,
    grossProfit: stats.grossProfit,
    grossLoss: stats.grossLoss,
    netProfit: stats.netProfit,
    averageWin: stats.averageWin,
    averageLoss: stats.averageLoss,
    payoffRatio: stats.payoffRatio,
    profitFactor: stats.profitFactor,
    expectancyPerTrade: stats.expectancyPerTrade,
    averagePayout: stats.averagePayout,
    breakEvenWinRate: stats.breakEvenWinRate,
    equityCurve: equityCurveData,
    drawdown: {
      maxDrawdown: dd.maxDrawdown,
      maxDrawdownPercent: dd.maxDrawdownPercent,
      currentDrawdown: dd.currentDrawdown,
      currentDrawdownPercent: dd.currentDrawdownPercent,
    },
    recoveryFactor: recoveryFactor(np, dd.maxDrawdown),
    streaks: {
      longestWinStreak: streaks.longestWinStreak,
      longestLossStreak: streaks.longestLossStreak,
      currentStreak: streaks.currentStreak,
    },
    bestAsset: byAsset[0] ?? null,
    worstAsset: byAsset[byAsset.length - 1] ?? null,
    winRateByAsset: byAsset,
    winRateByHour: byHour,
    winRateByWeekday: byWeekday,
    winRateByStrategy: byStrategy,
    winRateByEmotion: byEmotion,
    winRateByDirection: byDirection,
    followedPlanComparison: {
      followedCount: followedRaw.length,
      followedWinRate,
      followedNetPL,
      brokeCount: brokeRaw.length,
      brokeWinRate,
      brokeNetPL,
    },
    stakeDistribution,
    insights,
    periodComparison,
  };
}

// ─── Insights engine ──────────────────────────────────────────────────────

function computeInsights(
  trades: NormalizedTrade[],
  byEmotion: GroupStat[],
  byDirection: GroupStat[],
  byHour: GroupStat[],
): string[] {
  const insights: string[] = [];
  if (trades.length === 0) return insights;

  // 1. "Trades marked REVENGE cost you X"
  const revengeStat = byEmotion.find((s) => s.key === "REVENGE");
  if (revengeStat && revengeStat.count > 0 && revengeStat.netProfit < 0) {
    insights.push(
      `Trades marked REVENGE cost you ${revengeStat.netProfit.toFixed(2)} across ${revengeStat.count} trades. ` +
        `Win rate: ${(revengeStat.winRate * 100).toFixed(1)}%.`,
    );
  }

  // 2. "You lose X% of trades after N consecutive losses"
  // Find the win rate after 2+ consecutive losses.
  let afterLossCount = 0;
  let afterLossWins = 0;
  let currentLossStreak = 0;
  for (const t of trades) {
    if (currentLossStreak >= 2) {
      afterLossCount++;
      if (t.result === "WIN") afterLossWins++;
    }
    if (t.result === "LOSS") currentLossStreak++;
    else currentLossStreak = 0;
  }
  if (afterLossCount >= 3) {
    const afterLossWR = afterLossWins / afterLossCount;
    if (afterLossWR < 0.45) {
      insights.push(
        `After 2+ consecutive losses, you win only ${(afterLossWR * 100).toFixed(0)}% of trades ` +
          `(${afterLossWins} of ${afterLossCount}). Consider taking a break after a losing streak.`,
      );
    }
  }

  // 3. "Your best trading hour is X with Y% win rate"
  const bestHour = byHour.find(
    (s) =>
      s.count >= 3 &&
      s.winRate === Math.max(...byHour.filter((h) => h.count >= 3).map((h) => h.winRate)),
  );
  if (bestHour) {
    insights.push(
      `Your best trading hour is ${bestHour.key}:00 UTC with a ${(bestHour.winRate * 100).toFixed(0)}% win rate across ${bestHour.count} trades.`,
    );
  }

  // 4. CALL vs PUT imbalance
  const callStat = byDirection.find((s) => s.key === "CALL");
  const putStat = byDirection.find((s) => s.key === "PUT");
  if (callStat && putStat && callStat.count >= 5 && putStat.count >= 5) {
    const diff = Math.abs(callStat.winRate - putStat.winRate);
    if (diff > 0.15) {
      const better = callStat.winRate > putStat.winRate ? "CALL" : "PUT";
      const worse = better === "CALL" ? "PUT" : "CALL";
      insights.push(
        `You win ${(callStat.winRate * 100).toFixed(0)}% of CALL trades but only ${(putStat.winRate * 100).toFixed(0)}% of PUT trades. ` +
          `Your ${better} setups are significantly stronger — consider focusing there.`,
      );
    }
  }

  // 5. "Followed-plan vs broke-plan"
  // (This is computed separately in getAnalytics — add a generic insight here.)
  // 6. Profit factor check
  const pf = profitFactor(trades);
  if (pf < 0.9 && trades.length >= 10) {
    insights.push(
      `Your profit factor is ${pf.toFixed(2)} — below break-even (1.0). ` +
        `You're losing money overall. Consider reducing your stake size or reviewing your strategy.`,
    );
  } else if (pf > 1.5 && trades.length >= 10) {
    insights.push(`Profit factor of ${pf.toFixed(2)} — you're profitable. Keep the discipline.`);
  }

  return insights;
}
