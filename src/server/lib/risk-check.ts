/**
 * Phase 7 — Risk Rules Engine: real `evaluateRisk()` implementation.
 *
 * Replaces the Phase 5 stub (which returned `allowed: true`). The signature
 * + return shape are unchanged from Phase 5, so all existing call sites
 * in `trades.ts` keep working.
 *
 * Rules checked (in priority order — first BLOCK rule wins):
 *   1. Active lockout (not expired, not overridden) → BLOCK
 *   2. Daily loss reached (today's net P/L ≤ −maxDailyLoss) → BLOCK
 *   3. Weekly loss reached (week's net P/L ≤ −weeklyLossLimit) → BLOCK
 *   4. Daily profit target reached (today's net P/L ≥ dailyProfitTarget) → BLOCK
 *      (stop-when-ahead — protects gains)
 *   5. Max consecutive losses reached (current loss streak ≥ maxConsecutiveLosses) → BLOCK
 *   6. Max trades per day reached (today's trade count ≥ maxTradesPerDay) → BLOCK
 *   7. Too many open trades (open count ≥ maxOpenTrades) → BLOCK
 *   8. Stake > risk-per-trade limit (stake > riskPerTradePercent × balance) → WARN
 *
 * Timezone: "today" and "this week" are computed in the user's TZ
 * (via src/lib/timezone.ts).
 *
 * All checks are READ-ONLY — this function does NOT create lockouts.
 * `autoCreateLockoutAfterClose()` (in src/server/actions/lockout.ts) is
 * the function that creates lockouts AFTER a trade closes.
 */
import { db } from "@/lib/db";
import { startOfTodayUtc, startOfWeekUtc, nextMidnightUtc } from "@/lib/timezone";
import type { TradeDirection } from "@prisma/client";
import Decimal from "decimal.js";

export type RiskSeverity = "OK" | "WARN" | "BLOCK";

export type RiskCheckResult = {
  allowed: boolean;
  severity: RiskSeverity;
  reasons: string[];
  /** Optional metadata for the UI (e.g., to render the Risk Meter). */
  context?: {
    dailyPL: string;
    weeklyPL: string;
    tradesToday: number;
    openTrades: number;
    currentLossStreak: number;
    balance: string;
    riskPerTradeLimit: string;
  };
};

export type RiskCheckInput = {
  userId: string;
  tradingAccountId: string;
  stake: number | string;
  direction?: TradeDirection;
};

/**
 * Fetch the user's timezone from the User row. Default "UTC" if missing.
 */
async function getUserTimezone(userId: string): Promise<string> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return u?.timezone || "UTC";
}

/**
 * Fetch the RiskProfile for the account. Falls back to a global profile
 * (where tradingAccountId IS NULL) if the per-account profile doesn't
 * exist. Returns sensible defaults if neither exists (so brand-new users
 * without onboarding-set risk profiles still get reasonable limits).
 */
async function getRiskProfile(userId: string, tradingAccountId: string) {
  const perAccount = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId },
  });
  if (perAccount) return perAccount;

  // Global profile: where tradingAccountId IS NULL.
  // (Prisma unique constraint on (userId, tradingAccountId) treats NULLs as
  // distinct in SQLite — so technically there can be multiple. findFirst
  // returns the most recent one.)
  const global = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId: null },
    orderBy: { createdAt: "desc" },
  });
  if (global) return global;

  // Fallback defaults if no profile exists at all (shouldn't happen post-
  // onboarding, but be defensive).
  return {
    id: "default",
    userId,
    tradingAccountId,
    riskPerTradePercent: new Decimal(2),
    maxDailyLossPercent: new Decimal(6),
    maxDailyLossAmount: null,
    dailyProfitTargetPercent: null,
    maxTradesPerDay: 10,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 15,
    maxOpenTrades: 3,
    weeklyLossLimitPercent: null,
    lockoutEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Compute the current loss streak for the account — number of consecutive
 * LOSS trades ending at the most recent closed trade. Resets on WIN or TIE.
 */
async function getCurrentLossStreak(tradingAccountId: string): Promise<number> {
  const recentTrades = await db.trade.findMany({
    where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
    orderBy: { closedAt: "desc" },
    take: 50,
    select: { result: true },
  });
  let streak = 0;
  for (const t of recentTrades) {
    if (t.result === "LOSS") streak++;
    else break;
  }
  return streak;
}

/**
 * Fetch the active lockout for the user — one where expiresAt is null or
 * in the future AND overriddenAt is null. Returns null if no active lockout.
 *
 * Optional `now` parameter for testability (production callers omit it).
 */
export async function getActiveLockout(userId: string, now: Date = new Date()) {
  return db.lockout.findFirst({
    where: {
      userId,
      overriddenAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
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
}

/**
 * The main risk-evaluation function. Called from `createTradeAction`
 * (Phase 5) before saving a trade. Returns the verdict + reasons + context.
 *
 * The optional `now` parameter is for testability — production callers omit
 * it (defaults to `new Date()`); tests pass a fixed instant so the "today"
 * + "this week" calculation is deterministic.
 */
export async function evaluateRisk(
  input: RiskCheckInput,
  opts: { now?: Date } = {},
): Promise<RiskCheckResult> {
  const { userId, tradingAccountId } = input;
  const stake = new Decimal(input.stake.toString());
  const reasons: string[] = [];
  let severity: RiskSeverity = "OK";

  // Parallel-fetch everything we need for the rule checks.
  const timezone = await getUserTimezone(userId);
  const now = opts.now ?? new Date();
  const startOfToday = startOfTodayUtc(timezone, now);
  const startOfWeek = startOfWeekUtc(timezone, now);

  const [profile, account, activeLockout, todayTrades, weekTrades, openTrades, currentLossStreak] =
    await Promise.all([
      getRiskProfile(userId, tradingAccountId),
      db.tradingAccount.findUnique({
        where: { id: tradingAccountId },
        select: { currentBalance: true },
      }),
      // Lockouts are checked against `now` too, so the test-controlled instant
      // sees the right active/expired state.
      getActiveLockout(userId, now),
      db.trade.findMany({
        where: {
          userId,
          tradingAccountId,
          result: { in: ["WIN", "LOSS", "TIE"] },
          openedAt: { gte: startOfToday },
        },
        select: { profitLoss: true, result: true },
      }),
      db.trade.findMany({
        where: {
          userId,
          tradingAccountId,
          result: { in: ["WIN", "LOSS", "TIE"] },
          openedAt: { gte: startOfWeek },
        },
        select: { profitLoss: true, result: true },
      }),
      db.trade.count({
        where: {
          userId,
          tradingAccountId,
          result: "OPEN",
        },
      }),
      getCurrentLossStreak(tradingAccountId),
    ]);

  if (!account) {
    return {
      allowed: false,
      severity: "BLOCK",
      reasons: ["Account not found."],
    };
  }

  const balance = new Decimal(account.currentBalance.toString());

  // Compute daily + weekly P/L (negative for losses).
  const dailyPL = todayTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const weeklyPL = weekTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );

  // ─── Rule 1: Active lockout → BLOCK ─────────────────────────────────
  if (activeLockout) {
    severity = "BLOCK";
    const expiresIn = activeLockout.expiresAt
      ? ` (expires ${activeLockout.expiresAt.toISOString()})`
      : " (no expiry — override to resume)";
    reasons.push(`Active lockout: ${activeLockout.reason}${expiresIn}.`);
  }

  // ─── Rule 2: Daily loss reached → BLOCK ────────────────────────────
  // maxDailyLossPercent is a fraction of balance; maxDailyLossAmount is a
  // flat currency cap. Either triggers a block.
  const maxDailyLossPct = profile.maxDailyLossPercent
    ? new Decimal(profile.maxDailyLossPercent.toString())
    : null;
  const maxDailyLossAmt = profile.maxDailyLossAmount
    ? new Decimal(profile.maxDailyLossAmount.toString())
    : null;
  const dailyLossSoFar = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);
  if (maxDailyLossPct && dailyLossSoFar.gte(balance.mul(maxDailyLossPct).div(100))) {
    severity = "BLOCK";
    reasons.push(
      `Daily loss limit reached: ${dailyLossSoFar.toFixed(2)} of ${balance.mul(maxDailyLossPct).div(100).toFixed(2)} (${maxDailyLossPct.toFixed(2)}% of balance).`,
    );
  }
  if (maxDailyLossAmt && dailyLossSoFar.gte(maxDailyLossAmt)) {
    severity = "BLOCK";
    reasons.push(
      `Daily loss amount limit reached: ${dailyLossSoFar.toFixed(2)} of ${maxDailyLossAmt.toFixed(2)} cap.`,
    );
  }

  // ─── Rule 3: Weekly loss reached → BLOCK ────────────────────────────
  const weeklyLossLimitPct = profile.weeklyLossLimitPercent
    ? new Decimal(profile.weeklyLossLimitPercent.toString())
    : null;
  const weeklyLossSoFar = weeklyPL.lt(0) ? weeklyPL.abs() : new Decimal(0);
  if (weeklyLossLimitPct && weeklyLossSoFar.gte(balance.mul(weeklyLossLimitPct).div(100))) {
    severity = "BLOCK";
    reasons.push(
      `Weekly loss limit reached: ${weeklyLossSoFar.toFixed(2)} of ${balance.mul(weeklyLossLimitPct).div(100).toFixed(2)} (${weeklyLossLimitPct.toFixed(2)}% of balance).`,
    );
  }

  // ─── Rule 4: Daily profit target reached → BLOCK (stop-when-ahead) ──
  const dailyTargetPct = profile.dailyProfitTargetPercent
    ? new Decimal(profile.dailyProfitTargetPercent.toString())
    : null;
  if (dailyTargetPct && dailyPL.gte(balance.mul(dailyTargetPct).div(100))) {
    severity = "BLOCK";
    reasons.push(
      `Daily profit target reached: ${dailyPL.toFixed(2)} profit ≥ target ${balance.mul(dailyTargetPct).div(100).toFixed(2)} (${dailyTargetPct.toFixed(2)}% of balance). Stop-when-ahead.`,
    );
  }

  // ─── Rule 5: Max consecutive losses reached → BLOCK ─────────────────
  if (currentLossStreak >= profile.maxConsecutiveLosses) {
    severity = "BLOCK";
    reasons.push(
      `Max consecutive losses reached: ${currentLossStreak} in a row (limit ${profile.maxConsecutiveLosses}). Cooldown ${profile.cooldownMinutes}min applies.`,
    );
  }

  // ─── Rule 6: Max trades per day reached → BLOCK ────────────────────
  if (todayTrades.length >= profile.maxTradesPerDay) {
    severity = "BLOCK";
    reasons.push(
      `Max trades per day reached: ${todayTrades.length} of ${profile.maxTradesPerDay}.`,
    );
  }

  // ─── Rule 7: Too many open trades → BLOCK ──────────────────────────
  if (openTrades >= profile.maxOpenTrades) {
    severity = "BLOCK";
    reasons.push(`Too many open trades: ${openTrades} of ${profile.maxOpenTrades} max.`);
  }

  // ─── Rule 8: Stake > risk-per-trade limit → WARN ────────────────────
  const riskPerTradePct = new Decimal(profile.riskPerTradePercent.toString());
  const stakeLimit = balance.mul(riskPerTradePct).div(100);
  if (stake.gt(stakeLimit) && severity !== "BLOCK") {
    severity = "WARN";
    reasons.push(
      `Stake ${stake.toFixed(2)} exceeds risk-per-trade limit ${stakeLimit.toFixed(2)} (${riskPerTradePct.toFixed(2)}% of balance).`,
    );
  }

  // Aggregate: BLOCK reasons = BLOCK; if no BLOCK and any WARN reason = WARN.
  const hasBlock = severity === "BLOCK";
  const hasWarn = severity === "WARN";

  return {
    allowed: !hasBlock,
    severity: hasBlock ? "BLOCK" : hasWarn ? "WARN" : "OK",
    reasons,
    context: {
      dailyPL: dailyPL.toString(),
      weeklyPL: weeklyPL.toString(),
      tradesToday: todayTrades.length,
      openTrades,
      currentLossStreak,
      balance: balance.toString(),
      riskPerTradeLimit: stakeLimit.toString(),
    },
  };
}
