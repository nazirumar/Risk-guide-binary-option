/**
 * Phase 12 — Alert generation engine.
 *
 * Called from `closeTradeAction` AFTER the trade closes + balance recomputes
 * + auto-lockout check runs. Generates in-app notifications (and optionally
 * emails) when thresholds are crossed:
 *
 *   - RISK_LIMIT_80  — daily loss reached 80% of max daily loss limit
 *   - RISK_LIMIT_100 — daily loss reached 100% (lockout auto-created)
 *   - LOCKOUT_STARTED — a lockout was auto-created (companion to the Phase 7 lockout)
 *   - GOAL_ACHIEVED  — a goal's target was reached by today's P/L
 *
 * Uses the user's TZ to define "today" (same as Phase 7's risk-check engine).
 */
import { db } from "@/lib/db";
import { createNotificationIfAllowed } from "@/server/actions/notifications";
import { startOfTodayUtc } from "@/lib/timezone";
import Decimal from "decimal.js";

export async function checkAndCreateAlerts(
  userId: string,
  tradingAccountId: string,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone ?? "UTC";
  const now = new Date();
  const startOfToday = startOfTodayUtc(timezone, now);

  const [account, profile, todayTrades] = await Promise.all([
    db.tradingAccount.findFirst({
      where: { id: tradingAccountId, userId },
      select: { currentBalance: true },
    }),
    db.riskProfile.findFirst({
      where: { userId, tradingAccountId },
    }) ??
      db.riskProfile.findFirst({
        where: { userId, tradingAccountId: null },
        orderBy: { createdAt: "desc" },
      }),
    db.trade.findMany({
      where: {
        userId,
        tradingAccountId,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: startOfToday },
      },
      select: { profitLoss: true },
    }),
  ]);

  if (!account || !profile) return;

  const balance = new Decimal(account.currentBalance.toString());
  const dailyPL = todayTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const dailyLoss = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);

  // ─── RISK_LIMIT_80 / RISK_LIMIT_100 ──────────────────────────────────
  const maxDailyLossPct = profile.maxDailyLossPercent
    ? new Decimal(profile.maxDailyLossPercent.toString())
    : null;
  const maxDailyLossAmt = profile.maxDailyLossAmount
    ? new Decimal(profile.maxDailyLossAmount.toString())
    : null;

  // Use the smaller of the two limits (whichever is reached first).
  let limit: Decimal | null = null;
  if (maxDailyLossPct) {
    const pctLimit = balance.mul(maxDailyLossPct).div(100);
    limit = pctLimit;
  }
  if (maxDailyLossAmt) {
    limit = limit ? (maxDailyLossAmt.lt(limit) ? maxDailyLossAmt : limit) : maxDailyLossAmt;
  }

  if (limit && limit.gt(0)) {
    const usedPct = dailyLoss.div(limit);
    if (usedPct.gte(1)) {
      await createNotificationIfAllowed(
        userId,
        "RISK_LIMIT_100",
        "Daily loss limit reached",
        `You've hit your daily loss limit of ${limit.toFixed(2)}. Trading is locked until your next midnight.`,
      );
      await createNotificationIfAllowed(
        userId,
        "LOCKOUT_STARTED",
        "Auto-lockout: Daily loss",
        `Daily loss limit reached. Auto-locked out until your next midnight.`,
      );
    } else if (usedPct.gte(0.8)) {
      await createNotificationIfAllowed(
        userId,
        "RISK_LIMIT_80",
        "Approaching daily loss limit",
        `You've used ${usedPct.mul(100).toFixed(0)}% of your daily loss limit (${dailyLoss.toFixed(2)} of ${limit.toFixed(2)}). Consider stopping for the day.`,
      );
    }
  }

  // ─── GOAL_ACHIEVED ────────────────────────────────────────────────────
  const activeGoals = await db.goal.findMany({
    where: { userId, status: "ACTIVE" },
    select: { id: true, type: true, targetAmount: true },
  });
  for (const goal of activeGoals) {
    const target = new Decimal(goal.targetAmount.toString());
    let progress = new Decimal(0);
    if (goal.type === "DAILY") progress = dailyPL;
    // WEEKLY/MONTHLY/BALANCE_TARGET would need additional queries — keep it
    // simple for Phase 12; Phase 13 can add full goal-progress alerting.
    if (progress.gte(target)) {
      await createNotificationIfAllowed(
        userId,
        "GOAL_ACHIEVED",
        "Goal achieved! 🎯",
        `Your ${goal.type.toLowerCase()} goal of ${target.toFixed(2)} has been reached! Great discipline.`,
      );
      // Mark the goal as achieved.
      await db.goal.update({
        where: { id: goal.id },
        data: { status: "ACHIEVED" },
      });
    }
  }
}
