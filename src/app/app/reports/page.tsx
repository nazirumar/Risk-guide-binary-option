import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getAnalytics } from "@/server/lib/analytics";
import { db } from "@/lib/db";
import { ReportClient } from "@/components/reports/ReportClient";
import { WeeklyReviewCard } from "@/components/reports/WeeklyReviewCard";
import { formatMoney, formatDate, formatPercent } from "@/lib/format";
import { startOfTodayUtc, startOfWeekUtc } from "@/lib/timezone";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; preset?: string }>;
}) {
  const { userId, timezone } = await requireUser();

  // Phase 23: the AI-review opt-in flag (controls the "Generate now" button).
  const userFlags = await db.user.findUnique({
    where: { id: userId },
    select: { aiReviewEnabled: true },
  });
  const aiReviewEnabled = userFlags?.aiReviewEnabled ?? false;
  const sp = await searchParams;

  // Compute date range from preset or custom.
  const now = new Date();
  let dateFrom: Date;
  let dateTo: Date = now;
  const preset = sp.preset ?? "monthly";

  if (sp.from && sp.to) {
    dateFrom = new Date(sp.from);
    dateTo = new Date(sp.to);
    dateTo.setUTCHours(23, 59, 59, 999);
  } else if (preset === "daily") {
    dateFrom = startOfTodayUtc(timezone, now);
  } else if (preset === "weekly") {
    dateFrom = startOfWeekUtc(timezone, now);
  } else {
    // Monthly — start of current month.
    dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();

  // Fetch analytics for the report period.
  const analytics = await getAnalytics({
    userId,
    tradingAccountId: activeAccount?.id,
    dateFrom,
    dateTo,
  });

  // Fetch rule breaches (lockouts + overrides) for the period.
  const lockouts = await db.lockout.findMany({
    where: {
      userId,
      startedAt: { gte: dateFrom, lte: dateTo },
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      reason: true,
      startedAt: true,
      expiresAt: true,
      overriddenAt: true,
      overrideReason: true,
    },
  });

  // Fetch audit log entries for the period (overrides + breaches).
  const auditEntries = await db.auditLog.findMany({
    where: {
      userId,
      createdAt: { gte: dateFrom, lte: dateTo },
      action: { contains: "LOCKOUT" },
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, meta: true, createdAt: true },
  });

  // Best/worst trades from the analytics breakdown.
  const bestTrade = analytics.winRateByAsset[0] ?? null;
  const worstTrade = analytics.winRateByAsset[analytics.winRateByAsset.length - 1] ?? null;

  // Fetch session notes for the period.
  const sessionNotes = await db.tradingSession.findMany({
    where: {
      userId,
      startedAt: { gte: dateFrom, lte: dateTo },
      notes: { not: null },
    },
    select: { startedAt: true, endedAt: true, notes: true, mood: true },
    orderBy: { startedAt: "desc" },
    take: 10,
  });

  // Fetch daily journal entries for the period.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { dailyJournal: true },
  });
  const journal = (user?.dailyJournal as Record<string, string>) ?? {};
  const journalEntries = Object.entries(journal)
    .filter(([date]) => {
      const d = new Date(date);
      return d >= dateFrom && d <= dateTo;
    })
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 10);

  // Format the report data for the client.
  const reportData = {
    preset,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    summary: {
      totalTrades: analytics.counts.total,
      wins: analytics.counts.wins,
      losses: analytics.counts.losses,
      ties: analytics.counts.ties,
      winRate: analytics.winRate,
      netProfit: analytics.netProfit,
      profitFactor: analytics.profitFactor,
      expectancy: analytics.expectancyPerTrade,
      averageWin: analytics.averageWin,
      averageLoss: analytics.averageLoss,
      maxDrawdown: analytics.drawdown.maxDrawdown,
      maxDrawdownPercent: analytics.drawdown.maxDrawdownPercent,
      recoveryFactor: analytics.recoveryFactor,
      longestWinStreak: analytics.streaks.longestWinStreak,
      longestLossStreak: analytics.streaks.longestLossStreak,
      currentStreak: analytics.streaks.currentStreak,
      followedPlanCount: analytics.followedPlanComparison.followedCount,
      followedPlanWinRate: analytics.followedPlanComparison.followedWinRate,
      brokePlanCount: analytics.followedPlanComparison.brokeCount,
      brokePlanWinRate: analytics.followedPlanComparison.brokeWinRate,
    },
    equityCurve: analytics.equityCurve.map((d) => ({ date: d.date, balance: d.balance })),
    bestAsset: bestTrade
      ? {
          key: bestTrade.key,
          winRate: bestTrade.winRate,
          netProfit: bestTrade.netProfit,
          count: bestTrade.count,
        }
      : null,
    worstAsset: worstTrade
      ? {
          key: worstTrade.key,
          winRate: worstTrade.winRate,
          netProfit: worstTrade.netProfit,
          count: worstTrade.count,
        }
      : null,
    ruleBreaches: lockouts.map((l) => ({
      reason: l.reason,
      startedAt: l.startedAt.toISOString(),
      expiresAt: l.expiresAt?.toISOString() ?? null,
      overriddenAt: l.overriddenAt?.toISOString() ?? null,
      overrideReason: l.overrideReason,
    })),
    auditEntries: auditEntries.map((a) => ({
      action: a.action,
      meta: a.meta,
      createdAt: a.createdAt.toISOString(),
    })),
    sessionNotes: sessionNotes.map((s) => ({
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      notes: s.notes,
      mood: s.mood,
    })),
    journalEntries: journalEntries.map(([date, text]) => ({ date, text })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      type: a.type as "DEMO" | "REAL",
      currentBalance: a.currentBalance.toString(),
    })),
    activeAccountId: activeAccount?.id ?? null,
    currency: activeAccount?.currency ?? "USD",
  };

  return (
    <div className="space-y-6">
      {/* Phase 23 — AI weekly review */}
      <WeeklyReviewCard aiEnabled={aiReviewEnabled} />
      <ReportClient data={reportData} />
    </div>
  );
}
