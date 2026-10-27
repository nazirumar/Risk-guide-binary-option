"use server";

/**
 * Phase 7 — Lockout server actions.
 *
 * Three flows:
 *   1. Manual lockout ("I need a break") — `manualLockoutAction`
 *   2. Override (typing the confirmation phrase + reason) — `overrideLockoutAction`
 *   3. Auto-create lockout after a trade closes (called from closeTradeAction)
 *      — `autoCreateLockoutAfterClose`
 *
 * PROJECT_RULES.md rule #3: every query scoped by userId. Rule #9: audit-log
 * every change. PROJECT_RULES.md Phase 7 spec: "Override requires typing a
 * confirmation phrase and a reason; it is logged in AuditLog and shown in
 * reports (so the trader can see discipline breaches)."
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { manualLockoutSchema, overrideLockoutSchema } from "@/lib/validation";
import { startOfTodayUtc, startOfWeekUtc, nextMidnightUtc, nextWeekStartUtc } from "@/lib/timezone";
import { getActiveLockout } from "@/server/lib/risk-check";
import type { LockoutResult, BreachCheckResult } from "@/server/lib/lockout-types";

// ─── Manual lockout ("I need a break") ──────────────────────────────────────

export async function manualLockoutAction(formData: FormData): Promise<LockoutResult> {
  const { userId } = await requireUser();

  const parsed = manualLockoutSchema.safeParse({
    durationMinutes:
      formData.get("durationMinutes") && String(formData.get("durationMinutes")).length > 0
        ? Number(formData.get("durationMinutes"))
        : undefined,
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  // Don't stack manual lockouts — if there's an active one, just extend it.
  const active = await getActiveLockout(userId);
  if (active) {
    return { ok: false, message: "You already have an active lockout. Override it to resume." };
  }

  const durationMinutes = parsed.data.durationMinutes ?? 60;
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
  const lockout = await db.lockout.create({
    data: {
      userId,
      reason: "MANUAL",
      expiresAt,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "LOCKOUT_MANUAL",
      entity: "Lockout",
      entityId: lockout.id,
      meta: {
        durationMinutes,
        reason: parsed.data.reason ?? null,
      },
    },
  });

  revalidatePath("/app");
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `Manual lockout active for ${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}.`,
    lockoutId: lockout.id,
  };
}

// ─── Override (requires confirmation phrase + reason) ────────────────────

export async function overrideLockoutAction(formData: FormData): Promise<LockoutResult> {
  const { userId } = await requireUser();

  const parsed = overrideLockoutSchema.safeParse({
    lockoutId: formData.get("lockoutId"),
    confirmationPhrase: formData.get("confirmationPhrase"),
    overrideReason: formData.get("overrideReason"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const { lockoutId, overrideReason } = parsed.data;

  // Verify ownership.
  const lockout = await db.lockout.findFirst({
    where: { id: lockoutId, userId },
  });
  if (!lockout) return { ok: false, message: "Lockout not found." };
  if (lockout.overriddenAt) return { ok: false, message: "Lockout already overridden." };

  await db.lockout.update({
    where: { id: lockoutId },
    data: {
      overriddenAt: new Date(),
      overrideReason,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "LOCKOUT_OVERRIDDEN",
      entity: "Lockout",
      entityId: lockoutId,
      meta: {
        originalReason: lockout.reason,
        overrideReason,
        // The original expiry — useful for the audit trail to see "this
        // lockout was supposed to last 60 minutes but was overridden at 12."
        originalExpiresAt: lockout.expiresAt?.toISOString() ?? null,
        timeIntoLockoutMs: Date.now() - lockout.startedAt.getTime(),
      },
    },
  });

  revalidatePath("/app");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Lockout overridden. You can resume trading." };
}

// ─── Auto-create lockout after a breach (called from closeTradeAction) ─────

// BreachCheckResult is now imported from @/server/lib/lockout-types

/**
 * Called from `closeTradeAction` AFTER the trade is closed + balance is
 * recomputed. Checks if the close triggered a breach (daily loss, weekly
 * loss, consecutive losses). If yes, creates a Lockout with the appropriate
 * expiry.
 *
 * Returns the lockout info if one was created (so closeTradeAction can
 * surface the message to the user).
 *
 * Timezone-aware: "today" and "this week" use the user's TZ. Daily loss
 * lockouts expire at the user's next midnight; weekly loss at the next
 * week start (Sunday 00:00 user-TZ); consecutive-loss lockouts expire
 * after the profile's cooldownMinutes.
 */
export async function autoCreateLockoutAfterClose(
  userId: string,
  tradingAccountId: string,
): Promise<BreachCheckResult> {
  // Fetch user TZ + profile + account balance.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone || "UTC";
  const now = new Date();
  const startOfToday = startOfTodayUtc(timezone, now);
  const startOfWeek = startOfWeekUtc(timezone, now);

  const account = await db.tradingAccount.findFirst({
    where: { id: tradingAccountId, userId },
    select: { currentBalance: true },
  });
  if (!account) return { lockoutCreated: false };

  // Don't double-create lockouts — if there's already an active one, no-op.
  const activeLockout = await getActiveLockout(userId);
  if (activeLockout) return { lockoutCreated: false };

  // Per-account profile (fall back to global then defaults).
  const profile =
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId },
    })) ??
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: null },
      orderBy: { createdAt: "desc" },
    }));
  if (!profile) return { lockoutCreated: false };

  const balance = new Decimal(account.currentBalance.toString());

  // Fetch today's + this week's P/L.
  const [todayTrades, weekTrades] = await Promise.all([
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
  ]);

  const dailyPL = todayTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const weeklyPL = weekTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );

  // Check daily loss breach.
  const maxDailyLossPct = profile.maxDailyLossPercent
    ? new Decimal(profile.maxDailyLossPercent.toString())
    : null;
  const maxDailyLossAmt = profile.maxDailyLossAmount
    ? new Decimal(profile.maxDailyLossAmount.toString())
    : null;
  const dailyLossSoFar = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);

  if (
    (maxDailyLossPct && dailyLossSoFar.gte(balance.mul(maxDailyLossPct).div(100))) ||
    (maxDailyLossAmt && dailyLossSoFar.gte(maxDailyLossAmt))
  ) {
    const expiresAt = nextMidnightUtc(timezone, now);
    const lockout = await db.lockout.create({
      data: {
        userId,
        reason: "DAILY_LOSS",
        expiresAt,
      },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "LOCKOUT_AUTO_DAILY_LOSS",
        entity: "Lockout",
        entityId: lockout.id,
        meta: {
          dailyPL: dailyPL.toString(),
          maxDailyLossPct: maxDailyLossPct?.toString() ?? null,
          maxDailyLossAmt: maxDailyLossAmt?.toString() ?? null,
          balance: balance.toString(),
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return {
      lockoutCreated: true,
      reason: "DAILY_LOSS",
      expiresAt,
      message: `Daily loss limit reached. Auto-locked out until your next midnight (${timezone}).`,
    };
  }

  // Check weekly loss breach.
  const weeklyLossLimitPct = profile.weeklyLossLimitPercent
    ? new Decimal(profile.weeklyLossLimitPercent.toString())
    : null;
  const weeklyLossSoFar = weeklyPL.lt(0) ? weeklyPL.abs() : new Decimal(0);
  if (weeklyLossLimitPct && weeklyLossSoFar.gte(balance.mul(weeklyLossLimitPct).div(100))) {
    const expiresAt = nextWeekStartUtc(timezone, now);
    const lockout = await db.lockout.create({
      data: {
        userId,
        reason: "WEEKLY_LOSS",
        expiresAt,
      },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "LOCKOUT_AUTO_WEEKLY_LOSS",
        entity: "Lockout",
        entityId: lockout.id,
        meta: {
          weeklyPL: weeklyPL.toString(),
          weeklyLossLimitPct: weeklyLossLimitPct.toString(),
          balance: balance.toString(),
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return {
      lockoutCreated: true,
      reason: "WEEKLY_LOSS",
      expiresAt,
      message: `Weekly loss limit reached. Auto-locked out until next week start (${timezone}).`,
    };
  }

  // Check consecutive losses breach.
  const recentTrades = await db.trade.findMany({
    where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
    orderBy: { closedAt: "desc" },
    take: profile.maxConsecutiveLosses + 1,
    select: { result: true },
  });
  let streak = 0;
  for (const t of recentTrades) {
    if (t.result === "LOSS") streak++;
    else break;
  }
  if (streak >= profile.maxConsecutiveLosses) {
    const expiresAt = new Date(Date.now() + profile.cooldownMinutes * 60 * 1000);
    const lockout = await db.lockout.create({
      data: {
        userId,
        reason: "CONSEC_LOSSES",
        expiresAt,
      },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "LOCKOUT_AUTO_CONSEC_LOSSES",
        entity: "Lockout",
        entityId: lockout.id,
        meta: {
          streak,
          maxConsecutiveLosses: profile.maxConsecutiveLosses,
          cooldownMinutes: profile.cooldownMinutes,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return {
      lockoutCreated: true,
      reason: "CONSEC_LOSSES",
      expiresAt,
      message: `${streak} losses in a row. Auto-cooldown for ${profile.cooldownMinutes} minutes.`,
    };
  }

  return { lockoutCreated: false };
}

// ─── Expire old lockouts (called by the cron endpoint) ───────────────────

/**
 * Cleanup — deletes lockouts that have expired more than 7 days ago. Keeps
 * the lockout table small without losing recent forensic data.
 *
 * Returns the count of deleted rows.
 */
export async function expireOldLockouts(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.lockout.deleteMany({
    where: {
      expiresAt: { lt: cutoff },
      overriddenAt: { not: null }, // Don't delete overrides that are still within their original window
    },
  });
  return result.count;
}
