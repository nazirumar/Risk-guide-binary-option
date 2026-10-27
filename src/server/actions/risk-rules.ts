"use server";

/**
 * Phase 7 — RiskProfile CRUD server actions.
 *
 * The Risk Rules page calls these to edit the per-account (or global) risk
 * profile. PROJECT_RULES.md rule #3: every query scoped by userId.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { upsertRiskProfileSchema } from "@/lib/validation";

export type RiskRulesResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

/**
 * Fetch the per-account RiskProfile, falling back to the global profile
 * if no per-account one exists. Used by the Risk Rules page to populate
 * the form.
 */
export async function getRiskProfileForAccount(tradingAccountId: string) {
  const { userId } = await requireUser();
  // Verify ownership.
  const account = await db.tradingAccount.findFirst({
    where: { id: tradingAccountId, userId },
    select: { id: true, name: true, currency: true },
  });
  if (!account) return null;

  const perAccount = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId },
  });
  if (perAccount) return { ...perAccount, account };

  const global = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId: null },
    orderBy: { createdAt: "desc" },
  });
  if (global) return { ...global, account };

  return null;
}

/**
 * Upsert the RiskProfile for the given account. If the per-account profile
 * doesn't exist, create one. All numeric fields are validated + Decimal-ized.
 */
export async function upsertRiskProfileAction(formData: FormData): Promise<RiskRulesResult> {
  const { userId } = await requireUser();

  const parsed = upsertRiskProfileSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    riskPerTradePercent: Number(formData.get("riskPerTradePercent") ?? 2),
    maxDailyLossPercent: Number(formData.get("maxDailyLossPercent") ?? 6),
    maxDailyLossAmount:
      formData.get("maxDailyLossAmount") && String(formData.get("maxDailyLossAmount")).length > 0
        ? Number(formData.get("maxDailyLossAmount"))
        : null,
    dailyProfitTargetPercent:
      formData.get("dailyProfitTargetPercent") &&
      String(formData.get("dailyProfitTargetPercent")).length > 0
        ? Number(formData.get("dailyProfitTargetPercent"))
        : null,
    maxTradesPerDay: Number(formData.get("maxTradesPerDay") ?? 10),
    maxConsecutiveLosses: Number(formData.get("maxConsecutiveLosses") ?? 3),
    cooldownMinutes: Number(formData.get("cooldownMinutes") ?? 15),
    maxOpenTrades: Number(formData.get("maxOpenTrades") ?? 3),
    weeklyLossLimitPercent:
      formData.get("weeklyLossLimitPercent") &&
      String(formData.get("weeklyLossLimitPercent")).length > 0
        ? Number(formData.get("weeklyLossLimitPercent"))
        : null,
    lockoutEnabled: formData.get("lockoutEnabled") === "true",
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const d = parsed.data;
  // Verify ownership of the trading account.
  const owned = await db.tradingAccount.findFirst({
    where: { id: d.tradingAccountId, userId },
    select: { id: true },
  });
  if (!owned) return { ok: false, message: "Account not found." };

  // Find existing per-account profile.
  const existing = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId: d.tradingAccountId },
  });

  const data = {
    userId,
    tradingAccountId: d.tradingAccountId,
    riskPerTradePercent: new Decimal(d.riskPerTradePercent).toDecimalPlaces(4),
    maxDailyLossPercent: new Decimal(d.maxDailyLossPercent).toDecimalPlaces(4),
    maxDailyLossAmount: d.maxDailyLossAmount
      ? new Decimal(d.maxDailyLossAmount).toDecimalPlaces(2)
      : null,
    dailyProfitTargetPercent: d.dailyProfitTargetPercent
      ? new Decimal(d.dailyProfitTargetPercent).toDecimalPlaces(4)
      : null,
    maxTradesPerDay: d.maxTradesPerDay,
    maxConsecutiveLosses: d.maxConsecutiveLosses,
    cooldownMinutes: d.cooldownMinutes,
    maxOpenTrades: d.maxOpenTrades,
    weeklyLossLimitPercent: d.weeklyLossLimitPercent
      ? new Decimal(d.weeklyLossLimitPercent).toDecimalPlaces(4)
      : null,
    lockoutEnabled: d.lockoutEnabled,
  };

  if (existing) {
    await db.riskProfile.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await db.riskProfile.create({ data });
  }

  await db.auditLog.create({
    data: {
      userId,
      action: "RISK_PROFILE_UPDATED",
      entity: "RiskProfile",
      entityId: d.tradingAccountId,
      meta: JSON.parse(JSON.stringify(data)) as never,
    },
  });

  revalidatePath("/app/risk-rules");
  revalidatePath(`/app/accounts/${d.tradingAccountId}`);
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Risk profile updated." };
}
