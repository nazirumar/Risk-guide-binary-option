"use server";

/**
 * Phase 21 — Discipline Score server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #1:
 * money as Decimal. rule #8: state changes are audited.)
 *
 * Six actions:
 *
 *   - `computeDailyScoreAction(dateStr?)`  — compute + persist (upsert) the
 *       discipline score for one day. Defaults to today in the user's TZ.
 *       Returns the breakdown for the UI drawer.
 *
 *   - `getTodayScoreAction()` — read cached User.disciplineScore (or compute
 *       on demand if null/stale). Fast path for the dashboard card.
 *
 *   - `getScoreHistoryAction({ fromKey, toKey })` — range of DailyScore rows
 *       for the calendar view + the discipline-vs-profit chart.
 *
 *   - `getStreakStatsAction()` — current streak (walk backwards from today
 *       in user TZ), best streak, 7-day average, 30-day average.
 *
 *   - `recomputeRangeAction(fromKey, toKey)` — recompute every day in the
 *       range for the current user (manual refresh button).
 *
 *   - `sendDailyScoresSweepAction()` — cron-friendly: recompute yesterday
 *       for every user. Called by /api/cron/discipline-scores.
 *
 * NOTE: a "use server" file may only export async functions — non-async
 * types/helpers live in `./discipline-types.ts` if needed.
 */
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import type { TradeResult } from "@prisma/client";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccountId } from "@/server/actions/active-account";
import {
  dailyDisciplineScore,
  disciplinedDayStreak,
  bestStreak,
  averageScore,
  dayKeyInTz,
  shiftDayKey,
  type DisciplineScoreResult,
  type DailyScoreEntry,
  type DisciplineRuleBreakdown,
} from "@/lib/behavior/discipline";

export type DisciplineActionResult = {
  ok: boolean;
  message: string;
};

export type DailyScoreRow = {
  id: string;
  date: string; // YYYY-MM-DD in user TZ
  score: number; // 0-100
  breakdown: DisciplineRuleBreakdown[];
  isRestDay: boolean;
  updatedAt: Date;
};

export type ComputeScoreResult = DisciplineActionResult & {
  date?: string;
  score?: number;
  isRestDay?: boolean;
  breakdown?: DisciplineRuleBreakdown[];
};

export type StreakStatsResult = DisciplineActionResult & {
  todayScore?: number | null;
  todayIsRestDay?: boolean;
  currentStreak?: number;
  bestStreak?: number;
  sevenDayAverage?: number | null;
  thirtyDayAverage?: number | null;
  sevenDayScores?: DailyScoreEntry[];
  thirtyDayScores?: DailyScoreEntry[];
};

// ─── Ownership helper (mirror Phase 4/18/19 pattern) ──────────────────────

/**
 * Resolve the active trading account for the user. The discipline score is
 * computed per-user (not per-account) — the active account's risk profile
 * is used for the risk-per-trade-limit check. If the user has no active
 * account, the discipline score is computed with zero trades + zero
 * breaches (a rest day).
 */
async function getActiveAccountForUser(userId: string) {
  const activeId = await getActiveAccountId();
  if (!activeId) return null;
  return db.tradingAccount.findUnique({
    where: { id: activeId },
    select: {
      id: true,
      currency: true,
      startingBalance: true,
      currentBalance: true,
    },
  });
}

/**
 * Find the risk profile for the user. Per-account profile if one exists for
 * the active account, else the user's global profile (tradingAccountId=null).
 */
async function getRiskProfileForUser(userId: string, tradingAccountId: string | null) {
  if (tradingAccountId) {
    const perAccount = await db.riskProfile.findFirst({
      where: { userId, tradingAccountId },
    });
    if (perAccount) return perAccount;
  }
  return db.riskProfile.findFirst({
    where: { userId, tradingAccountId: null },
    orderBy: { createdAt: "desc" },
  });
}

// ─── 1. computeDailyScoreAction ────────────────────────────────────────────

/**
 * Compute + persist (upsert) the discipline score for one day. Defaults to
 * today in the user's TZ.
 *
 * Implementation:
 *   - Resolve the active account + risk profile.
 *   - Fetch the day's closed trades (WIN/LOSS/TIE) opened in the user's TZ.
 *   - For each trade, pre-compute `breachedRiskPerTrade` by comparing stake
 *     to (riskPerTradePercent × currentBalance). Note: this is the
 *     historical balance at the time of the trade — we use the account's
 *     current balance as a conservative proxy when the trade was the only
 *     one that day (more accurate per-trade balance tracking would require
 *     reading the trade's `balanceAfter` field, but for the breach check
 *     the current balance is close enough since the risk-per-trade percent
 *     is set against "current balance" at trade time).
 *   - Compute daily P/L + daily loss breach + trade count breach.
 *   - Count AuditLog entries for LOCKOUT_OVERRIDDEN (lockout overrides) +
 *     TRADE_OPENED with meta.riskSeverity=WARN (warning overrides) on
 *     that day.
 *   - Count TiltEvent rows (level=TILT) on that day.
 *   - Check TradingSession.checklistConfirmed=true on that day.
 *   - Check BalanceCheck rows exist on that day.
 *   - Call pure `dailyDisciplineScore` and upsert the DailyScore row.
 *   - If the day is "today", also update User.disciplineScore +
 *     User.disciplineScoreUpdatedAt for the fast dashboard read path.
 */
export async function computeDailyScoreAction(dateStr?: string): Promise<ComputeScoreResult> {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";
  const now = new Date();
  const todayKey = dayKeyInTz(now, tz);
  const targetKey = dateStr ?? todayKey;
  // For non-today days, we still compute based on the historical data — the
  // TZ boundaries are handled by the dayKey.

  // 1. Resolve active account + risk profile.
  const account = await getActiveAccountForUser(userId);
  const profile = await getRiskProfileForUser(userId, account?.id ?? null);

  // 2. Build the [start, end) UTC window for the target day in user TZ.
  // For "2025-06-15" in tz Africa/Lagos (UTC+1): the day starts at
  // 2025-06-14T23:00:00Z and ends at 2025-06-15T23:00:00Z.
  const [yyyy, mm, dd] = targetKey.split("-").map(Number);
  const startUtc = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  // Shift start backwards by the TZ offset to get the UTC instant that
  // corresponds to local midnight. We compute the offset by formatting
  // a sample instant in the TZ and comparing to its UTC counterpart.
  const tzOffsetMinutes = tzOffsetMinutesFor(tz, startUtc);
  const dayStartUtc = new Date(startUtc.getTime() - tzOffsetMinutes * 60_000);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  // 3. Parallel-fetch everything we need for the day.
  const tradingAccountId = account?.id ?? null;
  const [
    closedTrades,
    lockoutOverridesCount,
    warningOverridesCount,
    tiltEventsCount,
    tradingSessionCount,
    balanceCheckCount,
    avoidOverrideCount,
    userAvoidWeight,
  ] = await Promise.all([
    db.trade.findMany({
      where: {
        userId,
        ...(tradingAccountId ? { tradingAccountId } : {}),
        result: { in: ["WIN", "LOSS", "TIE"] as TradeResult[] },
        openedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
      orderBy: { openedAt: "asc" },
      select: {
        id: true,
        stake: true,
        followedPlan: true,
        openedAt: true,
        profitLoss: true,
      },
    }),
    db.auditLog.count({
      where: {
        userId,
        action: "LOCKOUT_OVERRIDDEN",
        createdAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
    }),
    db.auditLog
      .count({
        where: {
          userId,
          action: "TRADE_OPENED",
          createdAt: { gte: dayStartUtc, lt: dayEndUtc },
        },
      })
      .then(async (count) => {
        // SQLite can't filter on JSON, so we fetch the meta for the day's
        // TRADE_OPENED entries and count where meta.riskSeverity === "WARN".
        if (count === 0) return 0;
        const rows = await db.auditLog.findMany({
          where: {
            userId,
            action: "TRADE_OPENED",
            createdAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
          select: { meta: true },
        });
        return rows.filter((r) => {
          const meta = r.meta as { riskSeverity?: string } | null;
          return meta?.riskSeverity === "WARN";
        }).length;
      }),
    db.tiltEvent.count({
      where: {
        userId,
        level: "TILT",
        createdAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
    }),
    // Phase 10's TradingSession model doesn't store `checklistConfirmed` as
    // a field — it's a Zod precondition on `startSessionAction` (the action
    // rejects the call unless the user checked the box). So a session row
    // existing = checklist was confirmed.
    db.tradingSession.count({
      where: {
        userId,
        startedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
    }),
    db.balanceCheck.count({
      where: {
        userId,
        checkedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
    }),
    // Phase 29: trades saved that day after the trader proceeded past the
    // AVOID market warning (Trade row flag — rule #3 userId-scoped).
    db.trade.count({
      where: {
        userId,
        ignoredAvoidWarning: true,
        openedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { avoidOverrideWeight: true },
    }),
  ]);

  // 4. Compute the daily P/L + loss breach + trade count breach.
  const dailyPL = closedTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const balance = account ? new Decimal(account.currentBalance.toString()) : new Decimal(0);
  const maxDailyLossPct = profile?.maxDailyLossPercent
    ? new Decimal(profile.maxDailyLossPercent.toString())
    : null;
  const maxDailyLossAmt = profile?.maxDailyLossAmount
    ? new Decimal(profile.maxDailyLossAmount.toString())
    : null;
  const maxTradesPerDay = profile?.maxTradesPerDay ?? null;
  const riskPerTradePct = profile?.riskPerTradePercent
    ? new Decimal(profile.riskPerTradePercent.toString())
    : null;

  const dailyLossSoFar = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);
  const dailyLossBreached =
    (maxDailyLossPct != null && dailyLossSoFar.gte(balance.mul(maxDailyLossPct).div(100))) ||
    (maxDailyLossAmt != null && dailyLossSoFar.gte(maxDailyLossAmt));
  const tradeCountBreached = maxTradesPerDay != null && closedTrades.length > maxTradesPerDay;

  // 5. For each trade, pre-compute breachedRiskPerTrade.
  const tradesForCalc = closedTrades.map((t) => {
    const stake = new Decimal(t.stake.toString());
    // Conservative: use the current account balance (the historical balance
    // at trade time would be more accurate, but reading balanceAfter for
    // each trade would require joining through the trade's ledger; for the
    // discipline score, the current balance is close enough since the
    // risk-per-trade percent is a discipline signal, not exact accounting).
    const limit = riskPerTradePct ? balance.mul(riskPerTradePct).div(100) : stake; // no rule → never breach (vacuously)
    const breached = stake.gt(limit);
    return {
      id: t.id,
      stake: t.stake.toString(),
      followedPlan: t.followedPlan,
      breachedRiskPerTrade: breached,
    };
  });
  const riskPerTradeBreachedOnAnyTrade = tradesForCalc.some((t) => t.breachedRiskPerTrade);

  // 6. Call the pure calc.
  const result: DisciplineScoreResult = dailyDisciplineScore({
    trades: tradesForCalc,
    riskPerTradeBreachedOnAnyTrade,
    dailyLossBreached,
    tradeCountBreached,
    lockoutOverrides: lockoutOverridesCount,
    warningOverrides: warningOverridesCount,
    // Phase 29: ignored-AVOID trades + the user's configured weight.
    avoidOverrides: avoidOverrideCount,
    avoidOverrideWeight: userAvoidWeight?.avoidOverrideWeight ?? undefined,
    tiltEvents: tiltEventsCount,
    checklistCompleted: tradingSessionCount > 0,
    balanceCheckDone: balanceCheckCount > 0,
  });

  // 7. Upsert the DailyScore row.
  const breakdownJson = JSON.parse(JSON.stringify(result.breakdown));
  const upserted = await db.dailyScore.upsert({
    where: { userId_date: { userId, date: targetKey } },
    create: {
      userId,
      date: targetKey,
      score: new Decimal(result.score),
      breakdown: breakdownJson,
      isRestDay: result.isRestDay,
    },
    update: {
      score: new Decimal(result.score),
      breakdown: breakdownJson,
      isRestDay: result.isRestDay,
    },
  });

  // 8. If the target day is today, also update User.disciplineScore (fast
  // dashboard read path).
  if (targetKey === todayKey) {
    await db.user.update({
      where: { id: userId },
      data: {
        disciplineScore: new Decimal(result.score),
        disciplineScoreUpdatedAt: new Date(),
      },
    });
  }

  // Audit log (without the row-by-row tradeIds — those are in the breakdown).
  await db.auditLog.create({
    data: {
      userId,
      action: "DISCIPLINE_SCORE_COMPUTED",
      entity: "DailyScore",
      entityId: upserted.id,
      meta: {
        date: targetKey,
        score: result.score,
        isRestDay: result.isRestDay,
        trades: closedTrades.length,
      },
    },
  });

  // NOTE: We deliberately do NOT call revalidatePath here. computeDailyScoreAction
  // may be called during a Server Component render (the dashboard card calls
  // getStreakStatsAction which calls computeDailyScoreAction for today). Next.js 16
  // disallows revalidatePath during render. The Server Components on /app/dashboard
  // and /app/discipline re-fetch from DB on every navigation, so the latest
  // DailyScore row is always reflected on the next page load.
  return {
    ok: true,
    message: `Discipline score for ${targetKey}: ${result.score}.`,
    date: targetKey,
    score: result.score,
    isRestDay: result.isRestDay,
    breakdown: result.breakdown,
  };
}

// ─── 2. getTodayScoreAction ─────────────────────────────────────────────────

export async function getTodayScoreAction(): Promise<ComputeScoreResult> {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";
  const todayKey = dayKeyInTz(new Date(), tz);

  // Try the cached User.disciplineScore first (fast path).
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      disciplineScore: true,
      disciplineScoreUpdatedAt: true,
    },
  });

  // Stale check: if the cached score is from today, use it. Otherwise
  // compute fresh.
  const cached = user?.disciplineScoreUpdatedAt;
  const cachedToday = cached != null && dayKeyInTz(cached, tz) === todayKey;

  if (cachedToday && user?.disciplineScore != null) {
    // Also fetch the breakdown from the DailyScore row (the cached
    // User.disciplineScore is just the integer; the breakdown lives on
    // DailyScore).
    const row = await db.dailyScore.findUnique({
      where: { userId_date: { userId, date: todayKey } },
      select: { breakdown: true, isRestDay: true },
    });
    return {
      ok: true,
      message: "Today's score (cached).",
      date: todayKey,
      score: Number(user.disciplineScore.toString()),
      isRestDay: row?.isRestDay ?? false,
      breakdown: (row?.breakdown as DisciplineRuleBreakdown[]) ?? [],
    };
  }

  // Otherwise compute fresh.
  return computeDailyScoreAction(todayKey);
}

// ─── 3. getScoreHistoryAction ────────────────────────────────────────────────

export async function getScoreHistoryAction(input: {
  fromKey: string;
  toKey: string;
}): Promise<DisciplineActionResult & { rows?: DailyScoreRow[] }> {
  const { userId } = await requireUser();
  const rows = await db.dailyScore.findMany({
    where: {
      userId,
      date: { gte: input.fromKey, lte: input.toKey },
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      score: true,
      breakdown: true,
      isRestDay: true,
      updatedAt: true,
    },
  });
  return {
    ok: true,
    message: `${rows.length} days in range.`,
    rows: rows.map((r) => ({
      id: r.id,
      date: r.date,
      score: Number(r.score.toString()),
      breakdown: r.breakdown as DisciplineRuleBreakdown[],
      isRestDay: r.isRestDay,
      updatedAt: r.updatedAt,
    })),
  };
}

// ─── 4. getStreakStatsAction ────────────────────────────────────────────────

export async function getStreakStatsAction(): Promise<StreakStatsResult> {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";
  const now = new Date();
  const todayKey = dayKeyInTz(now, tz);

  // Always recompute today's score before reading the streak — the user
  // may have added trades/sessions/balance-checks since the last cron run,
  // and we want the dashboard to reflect the freshest data. The cron job
  // handles yesterday (and historical days); today is recomputed on demand.
  await computeDailyScoreAction(todayKey);

  // Fetch the last 365 days of DailyScore rows. We include today's row even
  // if it doesn't exist yet (the streak logic handles missing days as rest
  // days).
  const fromKey = shiftDayKey(todayKey, -365);
  const rows = await db.dailyScore.findMany({
    where: { userId, date: { gte: fromKey, lte: todayKey } },
    orderBy: { date: "asc" },
    select: { date: true, score: true, isRestDay: true },
  });
  const entries: DailyScoreEntry[] = rows.map((r) => ({
    date: r.date,
    score: Number(r.score.toString()),
    isRestDay: r.isRestDay,
  }));

  const currentStreak = disciplinedDayStreak(entries, todayKey);
  const best = bestStreak(entries);

  // 7-day + 30-day averages: slice the entries by date range.
  const sevenDayKey = shiftDayKey(todayKey, -6); // include today
  const thirtyDayKey = shiftDayKey(todayKey, -29); // include today
  const sevenDayEntries = entries.filter((e) => e.date >= sevenDayKey && e.date <= todayKey);
  const thirtyDayEntries = entries.filter((e) => e.date >= thirtyDayKey && e.date <= todayKey);

  const sevenDayAvg = averageScore(sevenDayEntries);
  const thirtyDayAvg = averageScore(thirtyDayEntries);

  // Read today's score from the now-fresh cached User field.
  const refreshedUser = await db.user.findUnique({
    where: { id: userId },
    select: { disciplineScore: true },
  });
  const todayScore =
    refreshedUser?.disciplineScore == null
      ? null
      : Number(refreshedUser.disciplineScore.toString());

  return {
    ok: true,
    message: `Current streak: ${currentStreak}. Best: ${best}.`,
    todayScore,
    todayIsRestDay: entries.find((e) => e.date === todayKey)?.isRestDay ?? false,
    currentStreak,
    bestStreak: best,
    sevenDayAverage: sevenDayAvg,
    thirtyDayAverage: thirtyDayAvg,
    sevenDayScores: sevenDayEntries,
    thirtyDayScores: thirtyDayEntries,
  };
}

// ─── 5. recomputeRangeAction ─────────────────────────────────────────────────

export async function recomputeRangeAction(input: {
  fromKey: string;
  toKey: string;
}): Promise<DisciplineActionResult & { recomputedCount?: number }> {
  const { userId } = await requireUser();
  // Walk the range day-by-day and call computeDailyScoreAction for each.
  // We can't pass through requireUser twice, so we inline the per-day
  // computation logic by re-calling computeDailyScoreAction (which is
  // session-aware and will reuse the same session).
  let cursor = input.fromKey;
  let count = 0;
  // Cap at 366 days to avoid runaway loops on bad input.
  for (let i = 0; i < 366; i++) {
    const res = await computeDailyScoreAction(cursor);
    if (res.ok) count++;
    if (cursor === input.toKey) break;
    cursor = shiftDayKey(cursor, 1);
  }
  // NOTE: same as computeDailyScoreAction — no revalidatePath here. The page
  // re-renders fresh on next navigation.
  return {
    ok: true,
    message: `Recomputed ${count} day${count === 1 ? "" : "s"}.`,
    recomputedCount: count,
  };
}

// ─── 6. sendDailyScoresSweepAction ───────────────────────────────────────────

/**
 * Cron-friendly: recompute yesterday's discipline score for every user.
 * Called by /api/cron/discipline-scores (token-protected with CRON_SECRET).
 *
 * Does NOT require `requireUser()` — it's a system-level sweep.
 *
 * For each user:
 *   - Compute yesterday's score in the user's TZ.
 *   - Upsert the DailyScore row.
 *   - (Don't update User.disciplineScore since this is yesterday's, not
 *     today's.)
 *
 * Returns { scannedCount, computedCount }.
 */
export async function sendDailyScoresSweepAction(): Promise<
  DisciplineActionResult & { scannedCount?: number; computedCount?: number }
> {
  // Fetch every user (active + onboarded) in one query.
  const users = await db.user.findMany({
    where: { isOnboarded: true },
    select: { id: true, timezone: true },
  });
  let computed = 0;
  for (const user of users) {
    try {
      const tz = user.timezone || "UTC";
      const now = new Date();
      const todayKey = dayKeyInTz(now, tz);
      const yesterdayKey = shiftDayKey(todayKey, -1);

      // Inline the per-user computation (we can't call computeDailyScoreAction
      // because it calls requireUser() which expects a session context).
      const account = await getActiveAccountForUser(user.id);
      const profile = await getRiskProfileForUser(user.id, account?.id ?? null);
      const [yyyy, mm, dd] = yesterdayKey.split("-").map(Number);
      const startUtc = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
      const tzOffsetMinutes = tzOffsetMinutesFor(tz, startUtc);
      const dayStartUtc = new Date(startUtc.getTime() - tzOffsetMinutes * 60_000);
      const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
      const tradingAccountId = account?.id ?? null;
      const [
        closedTrades,
        lockoutOverridesCount,
        warningOverridesRows,
        tiltEventsCount,
        tradingSessionCount,
        balanceCheckCount,
      ] = await Promise.all([
        db.trade.findMany({
          where: {
            userId: user.id,
            ...(tradingAccountId ? { tradingAccountId } : {}),
            result: { in: ["WIN", "LOSS", "TIE"] as TradeResult[] },
            openedAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
          select: { id: true, stake: true, followedPlan: true, profitLoss: true },
        }),
        db.auditLog.count({
          where: {
            userId: user.id,
            action: "LOCKOUT_OVERRIDDEN",
            createdAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
        }),
        db.auditLog.findMany({
          where: {
            userId: user.id,
            action: "TRADE_OPENED",
            createdAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
          select: { meta: true },
        }),
        db.tiltEvent.count({
          where: {
            userId: user.id,
            level: "TILT",
            createdAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
        }),
        db.tradingSession.count({
          where: {
            userId: user.id,
            startedAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
        }),
        db.balanceCheck.count({
          where: {
            userId: user.id,
            checkedAt: { gte: dayStartUtc, lt: dayEndUtc },
          },
        }),
      ]);
      const warningOverridesCount = warningOverridesRows.filter((r) => {
        const meta = r.meta as { riskSeverity?: string } | null;
        return meta?.riskSeverity === "WARN";
      }).length;

      const dailyPL = closedTrades.reduce(
        (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
        new Decimal(0),
      );
      const balance = account ? new Decimal(account.currentBalance.toString()) : new Decimal(0);
      const maxDailyLossPct = profile?.maxDailyLossPercent
        ? new Decimal(profile.maxDailyLossPercent.toString())
        : null;
      const maxDailyLossAmt = profile?.maxDailyLossAmount
        ? new Decimal(profile.maxDailyLossAmount.toString())
        : null;
      const maxTradesPerDay = profile?.maxTradesPerDay ?? null;
      const riskPerTradePct = profile?.riskPerTradePercent
        ? new Decimal(profile.riskPerTradePercent.toString())
        : null;
      const dailyLossSoFar = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);
      const dailyLossBreached =
        (maxDailyLossPct != null && dailyLossSoFar.gte(balance.mul(maxDailyLossPct).div(100))) ||
        (maxDailyLossAmt != null && dailyLossSoFar.gte(maxDailyLossAmt));
      const tradeCountBreached = maxTradesPerDay != null && closedTrades.length > maxTradesPerDay;

      const tradesForCalc = closedTrades.map((t) => {
        const stake = new Decimal(t.stake.toString());
        const limit = riskPerTradePct ? balance.mul(riskPerTradePct).div(100) : stake;
        return {
          id: t.id,
          stake: t.stake.toString(),
          followedPlan: t.followedPlan,
          breachedRiskPerTrade: stake.gt(limit),
        };
      });
      const result = dailyDisciplineScore({
        trades: tradesForCalc,
        riskPerTradeBreachedOnAnyTrade: tradesForCalc.some((t) => t.breachedRiskPerTrade),
        dailyLossBreached,
        tradeCountBreached,
        lockoutOverrides: lockoutOverridesCount,
        warningOverrides: warningOverridesCount,
        tiltEvents: tiltEventsCount,
        checklistCompleted: tradingSessionCount > 0,
        balanceCheckDone: balanceCheckCount > 0,
      });

      await db.dailyScore.upsert({
        where: { userId_date: { userId: user.id, date: yesterdayKey } },
        create: {
          userId: user.id,
          date: yesterdayKey,
          score: new Decimal(result.score),
          breakdown: JSON.parse(JSON.stringify(result.breakdown)),
          isRestDay: result.isRestDay,
        },
        update: {
          score: new Decimal(result.score),
          breakdown: JSON.parse(JSON.stringify(result.breakdown)),
          isRestDay: result.isRestDay,
        },
      });
      computed++;
    } catch {
      // Don't let one user's failure abort the sweep — skip + continue.
    }
  }

  return {
    ok: true,
    message: `Sweep complete: scanned ${users.length} user${users.length === 1 ? "" : "s"}, computed ${computed} score${computed === 1 ? "" : "s"}.`,
    scannedCount: users.length,
    computedCount: computed,
  };
}

// ─── TZ offset helper ─────────────────────────────────────────────────────────

/**
 * Compute the TZ offset (in minutes) for a given IANA timezone at a specific
 * UTC instant. Uses `Intl.DateTimeFormat` to format the wall-clock time
 * in the TZ + extracts the offset from the parts.
 *
 * Falls back to 0 (UTC) if the TZ is invalid.
 */
function tzOffsetMinutesFor(tz: string, d: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(d);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const y = Number(map.get("year"));
    const m = Number(map.get("month")) - 1;
    const day = Number(map.get("day"));
    const h = Number(map.get("hour")) === 24 ? 0 : Number(map.get("hour"));
    const min = Number(map.get("minute"));
    const sec = Number(map.get("second"));
    const asUtc = Date.UTC(y, m, day, h, min, sec);
    return Math.round((asUtc - d.getTime()) / 60_000);
  } catch {
    return 0;
  }
}
