"use server";

/**
 * Onboarding server action — completes the 3-step wizard in a single
 * transaction. Creates:
 *   - Updated User (isOnboarded=true, timezone, baseCurrency)
 *   - TradingAccount (with startingBalance = currentBalance)
 *   - RiskProfile (defaults: 2% risk, 6% daily loss, 3 max consec losses)
 *
 * PROJECT_RULES.md rule #3: userId is read from the session — never from form
 * data — so a malicious client can't write to another user's data.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { onboardingSchema } from "@/lib/validation";
import { requireUser } from "@/server/lib/require-user";

export type OnboardingResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export async function completeOnboardingAction(formData: FormData): Promise<OnboardingResult> {
  // skipOnboardingCheck: true — without this, requireUser() would throw a
  // redirect to /onboarding (because the user isn't onboarded yet), and the
  // wizard would never be able to complete itself.
  const { userId } = await requireUser({ skipOnboardingCheck: true });

  const parsed = onboardingSchema.safeParse({
    baseCurrency: String(formData.get("baseCurrency") ?? "").toUpperCase(),
    timezone: formData.get("timezone") ?? "",
    accountName: formData.get("accountName") ?? "",
    broker: formData.get("broker") ?? "",
    accountType: formData.get("accountType") ?? "DEMO",
    startingBalance: Number(formData.get("startingBalance") ?? 0),
    riskPerTradePercent: Number(formData.get("riskPerTradePercent") ?? 2),
    maxDailyLossPercent: Number(formData.get("maxDailyLossPercent") ?? 6),
    maxConsecutiveLosses: Number(formData.get("maxConsecutiveLosses") ?? 3),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      message: "Please fix the highlighted fields.",
      fieldErrors,
    };
  }

  const data = parsed.data;
  const startingBalance = new Decimal(data.startingBalance).toDecimalPlaces(2);

  await db.$transaction(async (tx) => {
    // 1. Update user locale + onboarding flag.
    await tx.user.update({
      where: { id: userId },
      data: {
        isOnboarded: true,
        timezone: data.timezone,
        baseCurrency: data.baseCurrency,
      },
    });

    // 2. Create the first trading account. (PROJECT_RULES.md Phase 4: do NOT
    //    create an extra DEPOSIT transaction — `startingBalance` is the
    //    snapshot, and the recompute formula is
    //    startingBalance + Σ(transactions) + Σ(trades). An extra DEPOSIT
    //    would double-count.)
    const account = await tx.tradingAccount.create({
      data: {
        userId,
        name: data.accountName,
        broker: data.broker,
        currency: data.baseCurrency,
        type: data.accountType,
        startingBalance,
        currentBalance: startingBalance,
      },
    });

    // 3. Risk profile scoped to the new account.
    await tx.riskProfile.create({
      data: {
        userId,
        tradingAccountId: account.id,
        riskPerTradePercent: new Decimal(data.riskPerTradePercent).toDecimalPlaces(4),
        maxDailyLossPercent: new Decimal(data.maxDailyLossPercent).toDecimalPlaces(4),
        maxConsecutiveLosses: data.maxConsecutiveLosses,
        lockoutEnabled: true,
      },
    });

    // 4. Audit trail.
    await tx.auditLog.create({
      data: {
        userId,
        action: "ONBOARDED",
        entity: "User",
        entityId: userId,
        meta: {
          accountId: account.id,
          accountName: account.name,
          startingBalance: startingBalance.toString(),
        },
      },
    });
  });

  revalidatePath("/app");
  return {
    ok: true,
    message: "Onboarding complete. Welcome to RiskGuard.",
  };
}
