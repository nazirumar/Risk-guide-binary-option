"use server";

/**
 * Phase 17 — Pre-trade confirmation server actions.
 *
 * Flow (Add Trade form):
 *   1. `prepareTradeConfirmationAction` — runs the SAME validation + risk
 *      check + tilt check as the save itself, then issues an HMAC-signed
 *      confirmation token binding the exact trade params. The token carries
 *      `notBefore = now + cooldownSeconds`, so the cooldown is enforced on
 *      the SERVER (createTradeAction rejects early confirms) — not just a
 *      disabled button.
 *   2. Client shows the modal with server-computed numbers
 *      (buildConfirmationSummary), a visible countdown, the optional plan
 *      checkbox and the optional reason-for-entry field.
 *   3a. Confirm → `createTradeAction` verifies the token (signature, user,
 *       expiry, cooldown, payload match) before saving.
 *   3b. Cancel → `cancelTradeAttemptAction` records a CancelledTradeAttempt
 *       ("trades you avoided") + audit log entry.
 *
 * PROJECT_RULES.md: rule #3 (every query userId-scoped), rule #4 (Zod on the
 * server), rule #8 (audit log on state changes), rule #1 (Decimal money).
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { evaluateRisk } from "@/server/lib/risk-check";
import { checkTiltForAccount } from "@/server/actions/tilt";
import { getNextStakeSuggestion } from "@/lib/staking";
import { buildConfirmationSummary } from "@/lib/calc/confirmation";
import { issueTradeConfirmationToken, extractTradeParams } from "@/server/lib/confirmation-token";
import {
  createTradeSchema,
  preTradeSettingsSchema,
  cancelTradeAttemptSchema,
} from "@/lib/validation";
import { describeCancelReason } from "@/server/actions/pre-trade-types";
import { buildMarketWarningInfo } from "@/server/lib/trade-market";
import type {
  PrepareConfirmationResult,
  CancelAttemptResult,
  PreTradeSettingsResult,
} from "@/server/actions/pre-trade-types";

/**
 * Read the user's pre-trade confirmation settings with sensible defaults.
 * (Mirrors the User model defaults so a missing row never crashes the flow.)
 */
async function getPreTradeSettings(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      preTradeConfirmSkipDemo: true,
      preTradeCooldownSeconds: true,
      preTradeRequirePlanCheckbox: true,
      preTradeReasonMode: true,
    },
  });
  return {
    skipDemo: user?.preTradeConfirmSkipDemo ?? false,
    cooldownSeconds: Math.min(15, Math.max(0, user?.preTradeCooldownSeconds ?? 5)),
    requirePlanCheckbox: user?.preTradeRequirePlanCheckbox ?? false,
    reasonMode: user?.preTradeReasonMode ?? "OPTIONAL",
  };
}

/** Same RiskProfile fallback as risk-check.ts: per-account → global → defaults. */
async function getRiskProfileForLimits(userId: string, tradingAccountId: string) {
  const perAccount = await db.riskProfile.findFirst({
    where: { userId, tradingAccountId },
  });
  const profile =
    perAccount ??
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: null },
      orderBy: { createdAt: "desc" },
    }));
  return {
    maxDailyLossPercent: profile?.maxDailyLossPercent?.toString() ?? null,
    maxDailyLossAmount: profile?.maxDailyLossAmount?.toString() ?? null,
    maxTradesPerDay: profile?.maxTradesPerDay ?? 10,
  };
}

// ─── Prepare confirmation (step 1 of the save flow) ────────────────────────

export async function prepareTradeConfirmationAction(
  formData: FormData,
): Promise<PrepareConfirmationResult> {
  const { userId } = await requireUser();

  // Same Zod validation the save will run — fail fast on bad fields.
  const parsed = createTradeSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    asset: formData.get("asset"),
    direction: formData.get("direction"),
    stake: Number(formData.get("stake") ?? 0),
    payoutPercent: Number(formData.get("payoutPercent") ?? 0),
    expiryMinutes: Number(formData.get("expiryMinutes") ?? 0),
    strategyId: formData.get("strategyId") || null,
    timeframe: formData.get("timeframe") || null,
    emotion: formData.get("emotion") || null,
    followedPlan: formData.get("followedPlan") === "true",
    setupNotes: formData.get("setupNotes") || null,
    screenshotUrl: formData.get("screenshotUrl") || null,
    tags: formData.getAll("tags").filter((t) => String(t).length > 0),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  // Ownership check on the trading account — never trust the form.
  const account = await db.tradingAccount.findFirst({
    where: { id: parsed.data.tradingAccountId, userId, isArchived: false },
    select: { id: true, currentBalance: true, currency: true, type: true },
  });
  if (!account) {
    return { ok: false, message: "Account not found or archived." };
  }

  // Risk check — BLOCK stops everything (same verdict the save would produce).
  const riskCheck = await evaluateRisk({
    userId,
    tradingAccountId: parsed.data.tradingAccountId,
    stake: parsed.data.stake,
    direction: parsed.data.direction,
  });
  if (!riskCheck.allowed) {
    return {
      ok: false,
      message: "Trade blocked by risk rule.",
      severity: "BLOCK",
      reasons: riskCheck.reasons,
    };
  }

  // Tilt check (Phase 16) — persists a TiltEvent when CAUTION/TILT. TILT
  // routes to the tilt dialog BEFORE the confirmation modal is shown.
  let tiltResult: PrepareConfirmationResult["tilt"] = undefined;
  try {
    const tilt = await checkTiltForAccount(userId, parsed.data.tradingAccountId);
    tiltResult = { score: tilt.score, level: tilt.level, signals: tilt.signals };
  } catch (e) {
    // Advisory only — a tilt failure must not block the flow.
    console.error("checkTiltForAccount failed:", e);
  }

  // Confirmation requirement: REAL accounts always confirm. DEMO accounts
  // skip it only when the user turned that on in Settings.
  const settings = await getPreTradeSettings(userId);
  const confirmationRequired = !(account.type === "DEMO" && settings.skipDemo);

  // Phase 29: live market rating + the trader's own pair×session record for
  // the pre-trade screen (hasData:false → "No market data", never a guess).
  const market = await buildMarketWarningInfo(
    userId,
    parsed.data.asset,
    account.type === "DEMO" ? "DEMO" : "REAL",
  );

  // Issue the signed token — binds the reviewed trade params + cooldown.
  const tradeParams = extractTradeParams(formData);
  if (!tradeParams) {
    return { ok: false, message: "Invalid trade parameters." };
  }
  const { token, payload } = issueTradeConfirmationToken({
    userId,
    trade: tradeParams,
    cooldownSeconds: settings.cooldownSeconds,
    enforceCooldown: confirmationRequired,
  });

  if (!confirmationRequired) {
    return {
      ok: true,
      message: "Confirmation skipped (DEMO account setting).",
      needsConfirmation: false,
      confirmationToken: token,
      severity: riskCheck.severity,
      reasons: riskCheck.reasons,
      tilt: tiltResult,
      market,
    };
  }

  // Build every number the modal shows — server-side, Decimal-precise.
  const [profileLimits, planSuggestion] = await Promise.all([
    getRiskProfileForLimits(userId, parsed.data.tradingAccountId),
    getNextStakeSuggestion(userId, parsed.data.tradingAccountId),
  ]);

  const summary = buildConfirmationSummary({
    stake: parsed.data.stake,
    payoutPercent: parsed.data.payoutPercent,
    asset: parsed.data.asset,
    direction: parsed.data.direction,
    expiryMinutes: parsed.data.expiryMinutes,
    balance: account.currentBalance.toString(),
    currency: account.currency,
    dailyPL: riskCheck.context?.dailyPL ?? "0",
    maxDailyLossPercent: profileLimits.maxDailyLossPercent,
    maxDailyLossAmount: profileLimits.maxDailyLossAmount,
    maxTradesPerDay: profileLimits.maxTradesPerDay,
    tradesToday: riskCheck.context?.tradesToday ?? 0,
    currentLossStreak: riskCheck.context?.currentLossStreak ?? 0,
    tiltLevel: tiltResult?.level ?? "CALM",
    tiltScore: tiltResult?.score ?? 0,
    planSuggestedStake: planSuggestion?.suggestedStake ?? null,
    planName: planSuggestion?.planName ?? null,
  });

  return {
    ok: true,
    message: "Confirmation required.",
    needsConfirmation: true,
    confirmationToken: token,
    notBefore: new Date(payload.notBefore).toISOString(),
    expiresAt: new Date(payload.expiresAt).toISOString(),
    summary,
    severity: riskCheck.severity,
    reasons: riskCheck.reasons,
    tilt: tiltResult,
    settings: {
      requirePlanCheckbox: settings.requirePlanCheckbox,
      reasonMode: settings.reasonMode,
    },
    market,
  };
}

// ─── Cancel attempt (step 3b) ───────────────────────────────────────────────

export async function cancelTradeAttemptAction(formData: FormData): Promise<CancelAttemptResult> {
  const { userId } = await requireUser();

  const parsed = cancelTradeAttemptSchema.safeParse({
    stake: Number(formData.get("stake") ?? 0),
    asset: formData.get("asset"),
    reason: formData.get("reason") || null,
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid cancellation data.",
    };
  }

  const reason = describeCancelReason(
    parsed.data.reason ?? null,
    formData.get("planChecked") === null ? null : formData.get("planChecked") === "true",
    (formData.get("reasonMode") as "OFF" | "OPTIONAL" | "REQUIRED" | null) ?? "OPTIONAL",
  );

  await db.$transaction(async (tx) => {
    await tx.cancelledTradeAttempt.create({
      data: {
        userId,
        stake: new Decimal(parsed.data.stake).toDecimalPlaces(2),
        asset: parsed.data.asset,
        reason,
      },
    });
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADE_CONFIRM_CANCELLED",
        entity: "CancelledTradeAttempt",
        entityId: "n/a",
        meta: {
          asset: parsed.data.asset,
          stake: parsed.data.stake,
          reason,
        },
      },
    });
  });

  revalidatePath("/app/dashboard");
  return { ok: true, message: "Trade cancelled and logged. Discipline kept." };
}

// ─── Settings (Phase 17 user preferences) ───────────────────────────────────

export async function updatePreTradeSettingsAction(
  formData: FormData,
): Promise<PreTradeSettingsResult> {
  const { userId } = await requireUser();

  const parsed = preTradeSettingsSchema.safeParse({
    skipDemo: formData.get("skipDemo") === "true",
    cooldownSeconds: Number(formData.get("cooldownSeconds") ?? 5),
    requirePlanCheckbox: formData.get("requirePlanCheckbox") === "true",
    reasonMode: formData.get("reasonMode") ?? "OPTIONAL",
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
  await db.user.update({
    where: { id: userId },
    data: {
      preTradeConfirmSkipDemo: d.skipDemo,
      preTradeCooldownSeconds: d.cooldownSeconds,
      preTradeRequirePlanCheckbox: d.requirePlanCheckbox,
      preTradeReasonMode: d.reasonMode,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "PRETRADE_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: JSON.parse(JSON.stringify(d)) as never,
    },
  });

  revalidatePath("/app/settings");
  return { ok: true, message: "Pre-trade confirmation settings saved." };
}
