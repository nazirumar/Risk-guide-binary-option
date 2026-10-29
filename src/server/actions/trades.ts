"use server";

/**
 * Phase 5 — Trade Journal server actions.
 *
 * PROJECT_RULES.md rule #1: money is Decimal. Rule #3: every query is scoped
 * by userId. Rule #9: every change is audit-logged. PROJECT_RULES.md Phase 4
 * rule: every trade mutation calls `recomputeAccountBalanceInTx()` inside
 * `prisma.$transaction` so the account balance + every trade's `balanceAfter`
 * stays consistent.
 *
 * Phase 7 will wire `evaluateRisk()` into `createTradeAction` so blocked
 * trades (over daily loss limit, in lockout, etc.) can't be saved.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { computeTradeProfitLoss } from "@/lib/calc/trade";
import { evaluateRisk } from "@/server/lib/risk-check";
import {
  verifyTradeConfirmationToken,
  cooldownRemainingMs,
  formDataMatchesToken,
} from "@/server/lib/confirmation-token";
import type { TradeConfirmationPayload } from "@/server/lib/confirmation-token";
import { autoCreateLockoutAfterClose } from "@/server/actions/lockout";
import {
  createTradeSchema,
  closeTradeSchema,
  updateTradeSchema,
  bulkDeleteTradesSchema,
} from "@/lib/validation";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { getTradeMarketSnapshot } from "@/server/lib/trade-market";

export type TradeActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  warning?: string;
  severity?: "OK" | "WARN" | "BLOCK";
  reasons?: string[];
  tilt?: {
    score: number;
    level: "CALM" | "CAUTION" | "TILT";
    signals: { signal: string; weight: number; detail: string }[];
  };
  tradeId?: string;
  newBalance?: string;
  /** Phase 17: true when the save was rejected because the confirmation
   *  cooldown is still running (server-side enforcement, not just UI). */
  cooldownRemainingSeconds?: number;
};

// ─── Pre-action ownership check ────────────────────────────────────────────

async function verifyTradeOwnership(tradeId: string, userId: string) {
  return db.trade.findFirst({
    where: { id: tradeId, userId },
    select: {
      id: true,
      tradingAccountId: true,
      result: true,
      stake: true,
      payoutPercent: true,
    },
  });
}

// ─── Create trade ──────────────────────────────────────────────────────────

export async function createTradeAction(formData: FormData): Promise<TradeActionResult> {
  const { userId } = await requireUser();

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
    confirmationToken: formData.get("confirmationToken")
      ? String(formData.get("confirmationToken"))
      : undefined,
    entryReason: formData.get("entryReason") ? String(formData.get("entryReason")) : undefined,
    ignoredAvoidWarning: formData.get("ignoredAvoidWarning") === "true",
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

  // Risk check (Phase 7). BLOCK prevents saving.
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
      severity: riskCheck.severity,
      reasons: riskCheck.reasons,
    };
  }

  // ── Phase 17: pre-trade confirmation enforcement ────────────────────────
  // REAL accounts always confirm. DEMO accounts skip only via the user's
  // setting. When confirmation applies, the signed token is MANDATORY and
  // its cooldown is checked against the SERVER clock.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      preTradeConfirmSkipDemo: true,
      preTradeRequirePlanCheckbox: true,
      preTradeReasonMode: true,
    },
  });
  const confirmationRequired = !(
    account.type === "DEMO" &&
    (user?.preTradeConfirmSkipDemo ?? false)
  );

  let verifiedPayload: TradeConfirmationPayload | null = null;
  const tokenRaw = parsed.data.confirmationToken;
  if (tokenRaw) {
    const verification = verifyTradeConfirmationToken(tokenRaw, userId);
    if (!verification.ok) {
      const messages: Record<string, string> = {
        MALFORMED: "Confirmation token is invalid — please review and save again.",
        BAD_SIGNATURE: "Confirmation token failed verification — please review and save again.",
        EXPIRED: "Confirmation expired — please review the trade and confirm again.",
        WRONG_USER: "Confirmation token does not belong to this user.",
      };
      return { ok: false, message: messages[verification.reason] ?? "Confirmation failed." };
    }
    verifiedPayload = verification.payload;

    // The confirmed trade must be the reviewed trade — any mismatch forces a
    // re-review so the modal numbers can never drift from what is saved.
    const match = formDataMatchesToken(formData, verification.payload.trade);
    if (!match.match) {
      return {
        ok: false,
        message: `Trade details changed after confirmation (${match.field}). Please review and confirm again.`,
      };
    }

    // SERVER-SIDE cooldown: reject the save while now < notBefore.
    const remainingMs = cooldownRemainingMs(verification.payload);
    if (remainingMs > 0) {
      return {
        ok: false,
        message: `Confirmation cooldown still active — wait ${Math.ceil(remainingMs / 1000)}s before confirming.`,
        cooldownRemainingSeconds: Math.ceil(remainingMs / 1000),
      };
    }
  } else if (confirmationRequired) {
    return {
      ok: false,
      message: "Pre-trade confirmation required. Press Save trade and confirm the details first.",
    };
  }

  // Settings enforcement: required plan checkbox + required entry reason.
  if (confirmationRequired) {
    if ((user?.preTradeRequirePlanCheckbox ?? false) && !parsed.data.followedPlan) {
      return {
        ok: false,
        message: "This trade is missing the required 'This trade follows my plan' confirmation.",
      };
    }
    if (
      (user?.preTradeReasonMode ?? "OPTIONAL") === "REQUIRED" &&
      (!parsed.data.entryReason || parsed.data.entryReason.trim().length === 0)
    ) {
      return {
        ok: false,
        message: "A reason for entry is required before confirming this trade.",
        fieldErrors: { entryReason: "Reason for entry is required." },
      };
    }
  }

  // Phase 16: tilt detection check. Skipped when a verified token is present —
  // prepareTradeConfirmationAction already ran it (re-running would duplicate
  // TiltEvents). Still runs on the no-token path (confirmation skipped for DEMO).
  let tiltCheck: Awaited<
    ReturnType<typeof import("@/server/actions/tilt").checkTiltForAccount>
  > | null = null;
  if (!verifiedPayload) {
    try {
      const { checkTiltForAccount } = await import("@/server/actions/tilt");
      tiltCheck = await checkTiltForAccount(userId, parsed.data.tradingAccountId);
    } catch (e) {
      // Tilt check is advisory — failures don't block the trade.
      console.error("checkTiltForAccount failed:", e);
    }
  }

  // Merge the modal's quick "reason for entry" into the journal notes.
  const entryReason = parsed.data.entryReason?.trim() || null;
  const mergedNotes =
    [
      parsed.data.setupNotes?.trim() || null,
      entryReason ? `Reason for entry: ${entryReason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n") || null;

  // Persist the trade atomically with the balance recompute.
  const stakeDecimal = new Decimal(parsed.data.stake).toDecimalPlaces(2);
  const payoutDecimal = new Decimal(parsed.data.payoutPercent).toDecimalPlaces(4);
  const openedAt = new Date();

  // Phase 29: snapshot the live market condition at save time. No data (OTC,
  // unknown pair, stale feed) → all-null + marketDataMissing — never faked.
  const marketSnapshot = await getTradeMarketSnapshot(parsed.data.asset, openedAt);
  // The AVOID choice is only meaningful when the condition actually IS AVOID
  // right now — a stale client flag must not label a trade it didn't apply to.
  const ignoredAvoidWarning =
    parsed.data.ignoredAvoidWarning && marketSnapshot.marketRating === "AVOID";

  const trade = await db.$transaction(async (tx) => {
    const t = await tx.trade.create({
      data: {
        userId,
        tradingAccountId: parsed.data.tradingAccountId,
        strategyId: parsed.data.strategyId || null,
        asset: parsed.data.asset,
        direction: parsed.data.direction,
        stake: stakeDecimal,
        payoutPercent: payoutDecimal,
        expiryMinutes: parsed.data.expiryMinutes,
        openedAt,
        result: "OPEN",
        profitLoss: new Decimal(0),
        timeframe: parsed.data.timeframe || null,
        setupNotes: mergedNotes,
        emotion: parsed.data.emotion || null,
        followedPlan: parsed.data.followedPlan,
        screenshotUrl: parsed.data.screenshotUrl || null,
        tags: parsed.data.tags,
        // Phase 29 — market condition snapshot at trade time.
        marketRating: marketSnapshot.marketRating,
        marketScore: marketSnapshot.marketScore,
        volatilityPercentile: marketSnapshot.volatilityPercentile,
        marketSession: marketSnapshot.marketSession,
        marketDataMissing: marketSnapshot.marketDataMissing,
        ignoredAvoidWarning,
      },
    });

    // Recompute (the OPEN trade contributes 0 to the balance since P/L=0,
    // but the call exercises the formula and keeps balanceAfter consistent).
    const { newBalance } = await recomputeAccountBalanceInTx(tx, parsed.data.tradingAccountId);

    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADE_OPENED",
        entity: "Trade",
        entityId: t.id,
        meta: {
          account: parsed.data.tradingAccountId,
          asset: parsed.data.asset,
          direction: parsed.data.direction,
          stake: stakeDecimal.toString(),
          payout: payoutDecimal.toString(),
          expiry: parsed.data.expiryMinutes,
          riskSeverity: riskCheck.severity,
          riskReasons: riskCheck.reasons,
          // Phase 17: confirmation provenance.
          confirmedViaToken: verifiedPayload ? true : false,
          confirmationJti: verifiedPayload?.jti ?? null,
          entryReason,
          // Phase 29: market snapshot + the AVOID-warning choice (rule #8).
          marketRating: marketSnapshot.marketRating,
          marketScore: marketSnapshot.marketScore,
          marketSession: marketSnapshot.marketSession,
          marketDataMissing: marketSnapshot.marketDataMissing,
          ignoredAvoidWarning,
        },
      },
    });
    return { trade: t, newBalance };
  });

  revalidatePath("/app/trades");
  revalidatePath(`/app/accounts/${parsed.data.tradingAccountId}`);
  revalidatePath("/app/dashboard");

  return {
    ok: true,
    message: `Trade saved: ${trade.trade.asset} ${parsed.data.direction} $${stakeDecimal.toFixed(2)}.`,
    tradeId: trade.trade.id,
    newBalance: trade.newBalance.toString(),
    severity: riskCheck.severity,
    reasons: riskCheck.reasons,
    warning:
      riskCheck.severity === "WARN" ? `Risk warning: ${riskCheck.reasons.join("; ")}` : undefined,
    tilt: tiltCheck
      ? {
          score: tiltCheck.score,
          level: tiltCheck.level,
          signals: tiltCheck.signals,
        }
      : undefined,
  };
}

// ─── Close trade (WIN / LOSS / TIE) ─────────────────────────────────────────

export async function closeTradeAction(formData: FormData): Promise<TradeActionResult> {
  const { userId } = await requireUser();

  const parsed = closeTradeSchema.safeParse({
    tradeId: formData.get("tradeId"),
    result: formData.get("result"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const trade = await verifyTradeOwnership(parsed.data.tradeId, userId);
  if (!trade) {
    return { ok: false, message: "Trade not found." };
  }
  if (trade.result !== "OPEN") {
    return { ok: false, message: `Trade already closed as ${trade.result}.` };
  }

  const profitLoss = computeTradeProfitLoss(
    trade.stake,
    trade.payoutPercent,
    parsed.data.result,
  ).toDecimalPlaces(2);
  const closedAt = new Date();

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.trade.update({
      where: { id: parsed.data.tradeId },
      data: {
        result: parsed.data.result,
        profitLoss,
        closedAt,
      },
    });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, trade.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADE_CLOSED",
        entity: "Trade",
        entityId: parsed.data.tradeId,
        meta: {
          result: parsed.data.result,
          profitLoss: profitLoss.toString(),
          newBalance: newBalance.toString(),
        },
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/trades");
  revalidatePath(`/app/accounts/${trade.tradingAccountId}`);
  revalidatePath("/app/dashboard");

  // Phase 7: after the trade closes + balance recomputes, check for breaches
  // (daily loss, weekly loss, consecutive losses). Auto-creates a Lockout if
  // any are triggered. Runs OUTSIDE the main transaction so the trade close
  // has already committed by the time we evaluate the new state.
  let lockoutMessage: string | undefined;
  try {
    const breach = await autoCreateLockoutAfterClose(userId, trade.tradingAccountId);
    if (breach.lockoutCreated && breach.message) {
      lockoutMessage = breach.message;
      // Refresh paths affected by the new lockout (banner shows on every page).
      revalidatePath("/app");
      revalidatePath("/app/dashboard");
    }
  } catch (e) {
    // If the breach-checker fails (shouldn't happen), don't fail the close.
    console.error("autoCreateLockoutAfterClose failed:", e);
  }

  // Phase 12: check for alert thresholds (risk 80%/100%, goal achieved) and
  // create in-app notifications. Non-blocking — failures are logged, not thrown.
  try {
    const { checkAndCreateAlerts } = await import("@/server/lib/alerts");
    await checkAndCreateAlerts(userId, trade.tradingAccountId);
    revalidatePath("/app");
  } catch (e) {
    console.error("checkAndCreateAlerts failed:", e);
  }

  return {
    ok: true,
    message:
      `Closed as ${parsed.data.result}. P/L: ${profitLoss.gte(0) ? "+" : ""}${profitLoss.toFixed(2)}. New balance: ${newBalance.toFixed(2)}.` +
      (lockoutMessage ? ` ${lockoutMessage}` : ""),
    newBalance: newBalance.toString(),
  };
}

// ─── Update trade (inline edit) ─────────────────────────────────────────────

export async function updateTradeAction(formData: FormData): Promise<TradeActionResult> {
  const { userId } = await requireUser();

  const parsed = updateTradeSchema.safeParse({
    tradeId: formData.get("tradeId"),
    tradingAccountId: formData.get("tradingAccountId") || undefined,
    asset: formData.get("asset") || undefined,
    direction: formData.get("direction") || undefined,
    stake: formData.get("stake") ? Number(formData.get("stake")) : undefined,
    payoutPercent: formData.get("payoutPercent")
      ? Number(formData.get("payoutPercent"))
      : undefined,
    expiryMinutes: formData.get("expiryMinutes")
      ? Number(formData.get("expiryMinutes"))
      : undefined,
    strategyId: formData.get("strategyId") || undefined,
    timeframe: formData.get("timeframe") || undefined,
    emotion: formData.get("emotion") || undefined,
    followedPlan: formData.get("followedPlan") === "true" ? true : undefined,
    setupNotes: formData.get("setupNotes") || undefined,
    screenshotUrl: formData.get("screenshotUrl") || undefined,
    tags:
      formData.getAll("tags").length > 0
        ? formData.getAll("tags").filter((t) => String(t).length > 0)
        : undefined,
    result: formData.get("result") || undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const trade = await verifyTradeOwnership(parsed.data.tradeId, userId);
  if (!trade) return { ok: false, message: "Trade not found." };

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === "tradeId") continue;
    if (value === undefined) continue;
    if (key === "stake") updates.stake = new Decimal(value as number).toDecimalPlaces(2);
    else if (key === "payoutPercent")
      updates.payoutPercent = new Decimal(value as number).toDecimalPlaces(4);
    else if (key === "tags") updates.tags = value as string[];
    else updates[key] = value;
  }

  // If the trade is already closed AND the user changed stake/payout/result,
  // the realized P/L must be recomputed. For OPEN trades, P/L stays 0.
  let recomputePL = false;
  if (updates.result && updates.result !== trade.result) {
    recomputePL = true;
  }
  if (updates.stake && trade.result !== "OPEN") {
    recomputePL = true;
  }
  if (updates.payoutPercent && trade.result !== "OPEN") {
    recomputePL = true;
  }

  const newResult = (updates.result as "WIN" | "LOSS" | "TIE" | "OPEN" | undefined) ?? trade.result;
  if (recomputePL && newResult !== "OPEN") {
    const stake = updates.stake ? (updates.stake as Decimal) : trade.stake;
    const payout = updates.payoutPercent ? (updates.payoutPercent as Decimal) : trade.payoutPercent;
    updates.profitLoss = computeTradeProfitLoss(
      stake,
      payout,
      newResult as "WIN" | "LOSS" | "TIE",
    ).toDecimalPlaces(2);
    // Set closedAt if not already set (when transitioning OPEN → closed, or
    // when stake/payout changed on an already-closed trade).
    if (!updates.closedAt) {
      updates.closedAt = new Date();
    }
  }

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.trade.update({
      where: { id: parsed.data.tradeId },
      data: updates as never,
    });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, trade.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADE_UPDATED",
        entity: "Trade",
        entityId: parsed.data.tradeId,
        meta: JSON.parse(JSON.stringify(updates)) as never,
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/trades");
  revalidatePath(`/app/accounts/${trade.tradingAccountId}`);
  revalidatePath("/app/dashboard");

  return {
    ok: true,
    message: "Trade updated.",
    newBalance: newBalance.toString(),
  };
}

// ─── Delete trade (single + bulk) ────────────────────────────────────────────

export async function deleteTradeAction(formData: FormData): Promise<TradeActionResult> {
  const { userId } = await requireUser();
  const tradeId = String(formData.get("tradeId") ?? "");
  if (!tradeId) return { ok: false, message: "Missing trade id." };

  const trade = await verifyTradeOwnership(tradeId, userId);
  if (!trade) return { ok: false, message: "Trade not found." };

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.trade.delete({ where: { id: tradeId } });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, trade.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADE_DELETED",
        entity: "Trade",
        entityId: tradeId,
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/trades");
  revalidatePath(`/app/accounts/${trade.tradingAccountId}`);
  revalidatePath("/app/dashboard");

  return {
    ok: true,
    message: `Trade deleted. New balance: ${newBalance.toFixed(2)}.`,
    newBalance: newBalance.toString(),
  };
}

export async function bulkDeleteTradesAction(formData: FormData): Promise<TradeActionResult> {
  const { userId } = await requireUser();
  const tradeIds = formData.getAll("tradeIds").map(String);

  const parsed = bulkDeleteTradesSchema.safeParse({ tradeIds });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid selection." };
  }

  // Verify all trades belong to the user. Group by tradingAccountId for the
  // post-delete recompute — one recompute per affected account.
  const trades = await db.trade.findMany({
    where: { id: { in: parsed.data.tradeIds }, userId },
    select: { id: true, tradingAccountId: true },
  });
  if (trades.length !== parsed.data.tradeIds.length) {
    return {
      ok: false,
      message: "Some trades were not found or don't belong to you.",
    };
  }
  const affectedAccounts = Array.from(new Set(trades.map((t) => t.tradingAccountId)));

  await db.$transaction(async (tx) => {
    await tx.trade.deleteMany({
      where: { id: { in: parsed.data.tradeIds }, userId },
    });
    for (const accountId of affectedAccounts) {
      await recomputeAccountBalanceInTx(tx, accountId);
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADES_BULK_DELETED",
        entity: "Trade",
        entityId: parsed.data.tradeIds[0],
        meta: {
          count: parsed.data.tradeIds.length,
          tradeIds: parsed.data.tradeIds,
        },
      },
    });
  });

  for (const accountId of affectedAccounts) {
    revalidatePath(`/app/accounts/${accountId}`);
  }
  revalidatePath("/app/trades");
  revalidatePath("/app/dashboard");

  return {
    ok: true,
    message: `Deleted ${parsed.data.tradeIds.length} trade${parsed.data.tradeIds.length === 1 ? "" : "s"}.`,
  };
}
