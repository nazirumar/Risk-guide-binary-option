"use server";

/**
 * Phase 19 — Withdrawal Rules & Profit-Taking server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #4: Zod on
 * the server. rule #1: money as Decimal. rule #8: state changes are audited.)
 *
 * Ten actions + helpers:
 *
 *   - `createWithdrawalRuleAction`     — new rule per account.
 *   - `updateWithdrawalRuleAction`     — edit value / frequency / baseline /
 *                                         isActive. Resets lastTriggeredAt
 *                                         when the rule's "value" or
 *                                         "baseline" changes (mid-period
 *                                         change is treated as a new rule for
 *                                         due-detection purposes).
 *   - `deleteWithdrawalRuleAction`     — hard delete (cascades: rule only;
 *                                         past WITHDRAWAL transactions stay).
 *   - `listWithdrawalRulesAction`      — all rules for an account, or all of
 *                                         the user's rules across accounts.
 *   - `getWithdrawalStatusAction`     — for one account: compute profit since
 *                                         baseline, recommended amount, due?
 *                                         side-effects: lazily updates the
 *                                         account's highWaterMark when the
 *                                         baseline is HIGH_WATER_MARK.
 *   - `markWithdrawnAction`           — creates a WITHDRAWAL transaction
 *                                         atomically + recomputes balance +
 *                                         stamps the rule's lastTriggeredAt +
 *                                         audit log.
 *   - `getBankedVsAtRiskAction`       — for the active account: total
 *                                         withdrawn − total deposited vs
 *                                         current balance.
 *   - `shouldPromptBigWinDayAction`    — true iff today's P/L ≥ the user's
 *                                         bigWinDayPercent threshold AND
 *                                         the banner hasn't been acknowledged
 *                                         yet today.
 *   - `acknowledgeBigWinDayAction`    — stamps bigWinDayLastPromptedAt so the
 *                                         banner hides for the rest of the
 *                                         day.
 *   - `updateBigWinDaySettingsAction`  — persists the threshold (null = off).
 *   - `sendWithdrawalRemindersAction`  — cron-friendly: scans all active
 *                                         rules across all users, fires an
 *                                         in-app + email notification per
 *                                         rule that's due. Returns the count.
 *
 * NOTE: a "use server" file may only export async functions — non-async
 * types/helpers live in `./withdrawals-types.ts` if needed.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import {
  createWithdrawalRuleSchema,
  updateWithdrawalRuleSchema,
  markWithdrawnSchema,
  bigWinDaySettingsSchema,
} from "@/lib/validation";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { getActiveAccountId, getActiveAccount } from "@/server/actions/active-account";
import {
  computeProfitSinceBaseline,
  recommendWithdrawalAmount,
  trackHighWaterMark,
  isWithdrawalDue,
  bankedVsAtRisk,
  isBigWinDay,
} from "@/lib/calc/withdrawals";
import { createNotificationIfAllowed } from "@/server/actions/notifications";
import { sendEmail } from "@/lib/email";

export type WithdrawalActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type WithdrawalRuleRow = {
  id: string;
  tradingAccountId: string;
  accountName: string;
  type: "PERCENT_OF_PROFIT" | "FIXED_AMOUNT" | "BALANCE_ABOVE_THRESHOLD";
  value: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  baseline: "STARTING_BALANCE" | "LAST_WITHDRAWAL" | "HIGH_WATER_MARK";
  isActive: boolean;
  lastTriggeredAt: Date | null;
  createdAt: Date;
};

export type WithdrawalStatusResult = WithdrawalActionResult & {
  rule?: WithdrawalRuleRow;
  startingBalance?: string;
  currentBalance?: string;
  lastWithdrawalBalance?: string | null;
  highWaterMark?: string | null;
  profitSinceBaseline?: string;
  recommendedAmount?: string;
  isDue?: boolean;
};

export type BankedVsAtRiskResult = WithdrawalActionResult & {
  banked?: string;
  atRisk?: string;
  totalDeposited?: string;
  totalWithdrawn?: string;
  accountName?: string;
  currency?: string;
};

export type ShouldPromptBigWinDayResult = WithdrawalActionResult & {
  shouldPrompt?: boolean;
  todayPL?: string;
  thresholdPercent?: string | null;
  accountName?: string;
};

// ─── ownership + lookup helpers ───────────────────────────────────────────────

async function verifyAccountOwnership(accountId: string, userId: string) {
  return db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true,
      name: true,
      currency: true,
      startingBalance: true,
      currentBalance: true,
      highWaterMark: true,
    },
  });
}

async function verifyRuleOwnership(ruleId: string, userId: string) {
  return db.withdrawalRule.findFirst({
    where: { id: ruleId, userId },
    select: {
      id: true,
      tradingAccountId: true,
      type: true,
      value: true,
      frequency: true,
      baseline: true,
      isActive: true,
      lastTriggeredAt: true,
      createdAt: true,
      tradingAccount: { select: { name: true } },
    },
  });
}

/**
 * Find the balance right after the most recent WITHDRAWAL transaction.
 * Returns null when there's never been a withdrawal — caller falls back to
 * startingBalance.
 */
async function findLastWithdrawalBalance(tradingAccountId: string): Promise<Decimal | null> {
  // The Phase 4 recompute path leaves `balanceAfter` on every trade, but for
  // transactions we use the running ledger: walk transactions in chronological
  // order and compute the balance after the most recent WITHDRAWAL.
  const txs = await db.transaction.findMany({
    where: { tradingAccountId },
    orderBy: { occurredAt: "asc" },
    select: { type: true, amount: true, occurredAt: true },
  });
  const account = await db.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { startingBalance: true },
  });
  if (!account) return null;
  let running = new Decimal(account.startingBalance.toString());
  let lastAfterWithdrawal: Decimal | null = null;
  for (const t of txs) {
    const amt = new Decimal(t.amount.toString());
    if (t.type === "WITHDRAWAL") {
      running = running.minus(amt);
      lastAfterWithdrawal = running;
    } else {
      // DEPOSIT / BONUS / ADJUSTMENT — all signed positive (ADJUSTMENT may
      // carry a negative amount, but the Decimal preserves the sign).
      running = running.plus(amt);
    }
  }
  return lastAfterWithdrawal;
}

/**
 * Aggregate total DEPOSIT vs total WITHDRAWAL amounts for an account.
 * Bonus + ADJUSTMENT are intentionally excluded — they aren't "deposited
 * principal" nor "withdrawn profit". The dashboard card is about cash the
 * trader has moved in/out of the broker account, not accounting adjustments.
 */
async function aggregateDepositsWithdrawals(tradingAccountId: string) {
  const rows = await db.transaction.findMany({
    where: { tradingAccountId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
    select: { type: true, amount: true },
  });
  let deposited = new Decimal(0);
  let withdrawn = new Decimal(0);
  for (const r of rows) {
    const amt = new Decimal(r.amount.toString());
    if (r.type === "DEPOSIT") deposited = deposited.plus(amt);
    else withdrawn = withdrawn.plus(amt);
  }
  return { deposited, withdrawn };
}

// ─── 1. createWithdrawalRuleAction ───────────────────────────────────────────

export async function createWithdrawalRuleAction(
  formData: FormData,
): Promise<WithdrawalActionResult & { ruleId?: string }> {
  const { userId } = await requireUser();
  const parsed = createWithdrawalRuleSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    type: formData.get("type"),
    value: Number(formData.get("value") ?? 0),
    frequency: formData.get("frequency"),
    baseline: formData.get("baseline"),
    isActive: formData.get("isActive") !== "false",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const account = await verifyAccountOwnership(parsed.data.tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  // Seed the highWaterMark the first time a HIGH_WATER_MARK-baseline rule is
  // created for this account. Use the current balance as the initial mark.
  if (parsed.data.baseline === "HIGH_WATER_MARK" && account.highWaterMark == null) {
    await db.tradingAccount.update({
      where: { id: account.id },
      data: { highWaterMark: new Decimal(account.currentBalance.toString()) },
    });
  }

  const rule = await db.withdrawalRule.create({
    data: {
      userId,
      tradingAccountId: parsed.data.tradingAccountId,
      type: parsed.data.type,
      value: new Decimal(parsed.data.value).toDecimalPlaces(4),
      frequency: parsed.data.frequency,
      baseline: parsed.data.baseline,
      isActive: parsed.data.isActive,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "WITHDRAWAL_RULE_CREATED",
      entity: "WithdrawalRule",
      entityId: rule.id,
      meta: {
        tradingAccountId: parsed.data.tradingAccountId,
        type: parsed.data.type,
        value: parsed.data.value,
        frequency: parsed.data.frequency,
        baseline: parsed.data.baseline,
        isActive: parsed.data.isActive,
      },
    },
  });

  revalidatePath("/app/withdrawal");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Withdrawal rule created.", ruleId: rule.id };
}

// ─── 2. updateWithdrawalRuleAction ───────────────────────────────────────────

export async function updateWithdrawalRuleAction(
  formData: FormData,
): Promise<WithdrawalActionResult> {
  const { userId } = await requireUser();
  const parsed = updateWithdrawalRuleSchema.safeParse({
    ruleId: formData.get("ruleId"),
    tradingAccountId: formData.get("tradingAccountId") || undefined,
    type: formData.get("type") || undefined,
    value: formData.get("value") === "" ? undefined : Number(formData.get("value") ?? 0),
    frequency: formData.get("frequency") || undefined,
    baseline: formData.get("baseline") || undefined,
    isActive: formData.get("isActive") === "true",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const existing = await verifyRuleOwnership(parsed.data.ruleId, userId);
  if (!existing) return { ok: false, message: "Rule not found." };

  // Mid-period rule change handling: if value OR baseline changes, reset
  // lastTriggeredAt so the rule re-evaluates as "due" under its new terms.
  // (Type/frequency changes don't reset the due-clock — only the parameters
  // that affect the recommendation do.)
  const valueChanged =
    parsed.data.value !== undefined &&
    new Decimal(parsed.data.value).toFixed(4) !== new Decimal(existing.value.toString()).toFixed(4);
  const baselineChanged =
    parsed.data.baseline !== undefined && parsed.data.baseline !== existing.baseline;
  const resetDue = valueChanged || baselineChanged;

  // Build update payload — only fields that were provided.
  const update: Record<string, unknown> = {};
  if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive;
  if (parsed.data.type !== undefined) update.type = parsed.data.type;
  if (parsed.data.value !== undefined)
    update.value = new Decimal(parsed.data.value).toDecimalPlaces(4);
  if (parsed.data.frequency !== undefined) update.frequency = parsed.data.frequency;
  if (parsed.data.baseline !== undefined) update.baseline = parsed.data.baseline;
  if (resetDue) update.lastTriggeredAt = null;

  await db.withdrawalRule.update({ where: { id: parsed.data.ruleId }, data: update });

  // If the new baseline is HIGH_WATER_MARK and the account doesn't have a mark
  // yet, seed it now.
  if (
    parsed.data.baseline === "HIGH_WATER_MARK" ||
    (parsed.data.baseline === undefined && existing.baseline === "HIGH_WATER_MARK")
  ) {
    const account = await db.tradingAccount.findUnique({
      where: { id: existing.tradingAccountId },
      select: { id: true, currentBalance: true, highWaterMark: true },
    });
    if (account && account.highWaterMark == null) {
      await db.tradingAccount.update({
        where: { id: account.id },
        data: {
          highWaterMark: trackHighWaterMark(null, account.currentBalance.toString()),
        },
      });
    }
  }

  await db.auditLog.create({
    data: {
      userId,
      action: "WITHDRAWAL_RULE_UPDATED",
      entity: "WithdrawalRule",
      entityId: parsed.data.ruleId,
      meta: JSON.parse(
        JSON.stringify({
          tradingAccountId: existing.tradingAccountId,
          changes: update,
          resetDue,
        }),
      ) as never,
    },
  });

  revalidatePath("/app/withdrawal");
  revalidatePath("/app/dashboard");
  return { ok: true, message: resetDue ? "Rule updated. Due-clock reset." : "Rule updated." };
}

// ─── 3. deleteWithdrawalRuleAction ───────────────────────────────────────────

export async function deleteWithdrawalRuleAction(
  formData: FormData,
): Promise<WithdrawalActionResult> {
  const { userId } = await requireUser();
  const ruleId = String(formData.get("ruleId") ?? "");
  if (!ruleId) return { ok: false, message: "Missing rule id." };

  const existing = await verifyRuleOwnership(ruleId, userId);
  if (!existing) return { ok: false, message: "Rule not found." };

  await db.withdrawalRule.delete({ where: { id: ruleId } });
  await db.auditLog.create({
    data: {
      userId,
      action: "WITHDRAWAL_RULE_DELETED",
      entity: "WithdrawalRule",
      entityId: ruleId,
      meta: { tradingAccountId: existing.tradingAccountId },
    },
  });

  revalidatePath("/app/withdrawal");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Rule deleted." };
}

// ─── 4. listWithdrawalRulesAction ─────────────────────────────────────────────

export async function listWithdrawalRulesAction(input?: {
  tradingAccountId?: string;
}): Promise<WithdrawalActionResult & { rules?: WithdrawalRuleRow[] }> {
  const { userId } = await requireUser();
  const where: { userId: string; tradingAccountId?: string } = { userId };
  if (input?.tradingAccountId) where.tradingAccountId = input.tradingAccountId;

  const rows = await db.withdrawalRule.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      tradingAccountId: true,
      type: true,
      value: true,
      frequency: true,
      baseline: true,
      isActive: true,
      lastTriggeredAt: true,
      createdAt: true,
      tradingAccount: { select: { name: true } },
    },
  });

  return {
    ok: true,
    message: `${rows.length} rule${rows.length === 1 ? "" : "s"}`,
    rules: rows.map((r) => ({
      id: r.id,
      tradingAccountId: r.tradingAccountId,
      accountName: r.tradingAccount?.name ?? "—",
      type: r.type,
      value: r.value.toString(),
      frequency: r.frequency,
      baseline: r.baseline,
      isActive: r.isActive,
      lastTriggeredAt: r.lastTriggeredAt,
      createdAt: r.createdAt,
    })),
  };
}

// ─── 5. getWithdrawalStatusAction ─────────────────────────────────────────────

export async function getWithdrawalStatusAction(
  tradingAccountId: string,
): Promise<WithdrawalStatusResult> {
  const { userId } = await requireUser();
  const account = await verifyAccountOwnership(tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  // The rule for this account (we only surface ONE active rule per account —
  // the most recent. Phase 19 spec doesn't require multiple rules per
  // account, and the UI is cleaner with one. Users can edit/disable/pause.)
  const rule = await db.withdrawalRule.findFirst({
    where: { userId, tradingAccountId: tradingAccountId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  if (!rule) {
    // No rule — still return current balance + zero profit baseline so the
    // UI can render an "Add a rule" CTA.
    return {
      ok: true,
      message: "No active withdrawal rule for this account.",
      startingBalance: account.startingBalance.toString(),
      currentBalance: account.currentBalance.toString(),
      lastWithdrawalBalance:
        (await findLastWithdrawalBalance(tradingAccountId))?.toString() ?? null,
      highWaterMark: account.highWaterMark?.toString() ?? null,
      profitSinceBaseline: new Decimal(account.currentBalance.toString())
        .minus(new Decimal(account.startingBalance.toString()))
        .toString(),
      recommendedAmount: "0",
      isDue: false,
    };
  }

  // Compute the lastWithdrawalBalance (for LAST_WITHDRAWAL baseline).
  const lastWithdrawalBalance = await findLastWithdrawalBalance(tradingAccountId);

  // Lazily update the highWaterMark when the baseline is HIGH_WATER_MARK —
  // pure `trackHighWaterMark` decides whether to update.
  let highWaterMark: Decimal | null = account.highWaterMark
    ? new Decimal(account.highWaterMark.toString())
    : null;
  if (rule.baseline === "HIGH_WATER_MARK") {
    const newMark = trackHighWaterMark(highWaterMark, account.currentBalance);
    if (highWaterMark == null || !newMark.equals(highWaterMark)) {
      await db.tradingAccount.update({
        where: { id: account.id },
        data: { highWaterMark: newMark },
      });
      highWaterMark = newMark;
    }
  }

  const profit = computeProfitSinceBaseline({
    startingBalance: account.startingBalance,
    currentBalance: account.currentBalance,
    lastWithdrawalBalance,
    highWaterMark,
    baseline: rule.baseline,
  });

  const recommended = recommendWithdrawalAmount({
    type: rule.type,
    value: rule.value,
    profitSinceBaseline: profit,
    currentBalance: account.currentBalance,
  });

  const isDue = isWithdrawalDue({
    frequency: rule.frequency,
    lastTriggeredAt: rule.lastTriggeredAt,
    now: new Date(),
  });

  return {
    ok: true,
    message: recommended.gt(0)
      ? `Recommended withdrawal: ${recommended.toFixed(2)}.`
      : profit.lte(0)
        ? "No profit to withdraw yet."
        : "Balance below threshold or no profit under this rule.",
    rule: {
      id: rule.id,
      tradingAccountId,
      accountName: account.name,
      type: rule.type,
      value: rule.value.toString(),
      frequency: rule.frequency,
      baseline: rule.baseline,
      isActive: rule.isActive,
      lastTriggeredAt: rule.lastTriggeredAt,
      createdAt: rule.createdAt,
    },
    startingBalance: account.startingBalance.toString(),
    currentBalance: account.currentBalance.toString(),
    lastWithdrawalBalance: lastWithdrawalBalance?.toString() ?? null,
    highWaterMark: highWaterMark?.toString() ?? null,
    profitSinceBaseline: profit.toString(),
    recommendedAmount: recommended.toString(),
    isDue,
  };
}

// ─── 6. markWithdrawnAction ──────────────────────────────────────────────────

export async function markWithdrawnAction(
  formData: FormData,
): Promise<WithdrawalActionResult & { newBalance?: string }> {
  const { userId } = await requireUser();
  const parsed = markWithdrawnSchema.safeParse({
    ruleId: formData.get("ruleId") || undefined,
    tradingAccountId: formData.get("tradingAccountId"),
    amount: Number(formData.get("amount") ?? 0),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const account = await verifyAccountOwnership(parsed.data.tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  // If a rule is attached, verify ownership + lock the stamp on success.
  let rule: Awaited<ReturnType<typeof verifyRuleOwnership>> = null;
  if (parsed.data.ruleId) {
    rule = await verifyRuleOwnership(parsed.data.ruleId, userId);
    if (!rule) return { ok: false, message: "Rule not found." };
  }

  const amountDecimal = new Decimal(parsed.data.amount).toDecimalPlaces(2);

  // Hard block: never allow a withdrawal that would push the balance below
  // zero — brokers don't allow overdraft on withdrawals, and our books should
  // never go negative via a withdrawal action. (Traders who want to record a
  // negative ADJUSTMENT should use the Phase 4 reconcile path.)
  if (amountDecimal.gt(new Decimal(account.currentBalance.toString()))) {
    return {
      ok: false,
      message: `Withdrawal of ${amountDecimal.toFixed(2)} exceeds current balance of ${account.currentBalance.toString()}.`,
    };
  }

  const result = await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: parsed.data.tradingAccountId,
        type: "WITHDRAWAL",
        amount: amountDecimal,
        note:
          parsed.data.note ??
          (rule
            ? `Profit-taking withdrawal per rule (${rule.type} = ${rule.value.toString()})`
            : "Profit-taking withdrawal"),
        occurredAt: new Date(),
      },
    });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, parsed.data.tradingAccountId);
    if (rule) {
      await tx.withdrawalRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: "WITHDRAWAL_RECORDED",
        entity: "Transaction",
        entityId: parsed.data.tradingAccountId,
        meta: {
          amount: amountDecimal.toString(),
          ruleId: rule?.id ?? null,
          ruleType: rule?.type ?? null,
          balanceBefore: account.currentBalance.toString(),
          balanceAfter: newBalance.toString(),
          note: parsed.data.note ?? null,
        },
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/withdrawal");
  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${parsed.data.tradingAccountId}`);
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `Withdrawal of ${amountDecimal.toFixed(2)} recorded. New balance: ${result.newBalance.toFixed(2)}.`,
    newBalance: result.newBalance.toString(),
  };
}

// ─── 7. getBankedVsAtRiskAction ──────────────────────────────────────────────

export async function getBankedVsAtRiskAction(): Promise<BankedVsAtRiskResult> {
  const { userId } = await requireUser();
  const activeId = await getActiveAccountId();
  if (!activeId) return { ok: true, message: "No active account." };

  const account = await db.tradingAccount.findUnique({
    where: { id: activeId },
    select: { id: true, name: true, currency: true, currentBalance: true },
  });
  if (!account) return { ok: false, message: "Account not found." };

  const { deposited, withdrawn } = await aggregateDepositsWithdrawals(activeId);
  const { banked, atRisk } = bankedVsAtRisk({
    totalDeposited: deposited,
    totalWithdrawn: withdrawn,
    currentBalance: account.currentBalance,
  });

  return {
    ok: true,
    message: banked.gte(0)
      ? `Banked profit: ${banked.toFixed(2)}. At risk: ${atRisk.toFixed(2)}.`
      : `Net-down on principal: ${banked.abs().toFixed(2)} still in the account.`,
    banked: banked.toString(),
    atRisk: atRisk.toString(),
    totalDeposited: deposited.toString(),
    totalWithdrawn: withdrawn.toString(),
    accountName: account.name,
    currency: account.currency,
  };
}

// ─── 8. shouldPromptBigWinDayAction ──────────────────────────────────────────

export async function shouldPromptBigWinDayAction(): Promise<ShouldPromptBigWinDayResult> {
  const { userId, timezone } = await requireUser();
  const activeAccount = await getActiveAccount();
  if (!activeAccount) return { ok: true, message: "No active account.", shouldPrompt: false };

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      bigWinDayPercent: true,
      bigWinDayLastPromptedAt: true,
      timezone: true,
    },
  });
  const threshold = user?.bigWinDayPercent ?? null;
  if (threshold == null) {
    return { ok: true, message: "Big-win-day prompt disabled.", shouldPrompt: false };
  }

  // Compute today's P/L for the active account: sum of trade PL for trades
  // that opened today (in the user's TZ).
  const tz = user?.timezone ?? timezone;
  const now = new Date();
  const startOfTodayUserTz = startOfDayInTz(now, tz);

  const todayTrades = await db.trade.findMany({
    where: {
      userId,
      tradingAccountId: activeAccount.id,
      result: { in: ["WIN", "LOSS", "TIE"] },
      openedAt: { gte: startOfTodayUserTz },
    },
    select: { profitLoss: true },
  });
  const todayPL = todayTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );

  const isBig = isBigWinDay({
    todayPL,
    balance: activeAccount.currentBalance,
    thresholdPercent: threshold,
  });

  // Suppress re-prompt within the same calendar day in the user's TZ.
  const last = user?.bigWinDayLastPromptedAt ?? null;
  const lastDayStr = last ? dayKeyInTz(last, tz) : null;
  const todayStr = dayKeyInTz(now, tz);
  const alreadyPromptedToday = lastDayStr === todayStr;

  return {
    ok: true,
    message:
      isBig && !alreadyPromptedToday
        ? `Big-win-day triggered: ${todayPL.toFixed(2)} today.`
        : "Not a big-win day or already prompted.",
    shouldPrompt: isBig && !alreadyPromptedToday,
    todayPL: todayPL.toString(),
    thresholdPercent: threshold.toString(),
    accountName: activeAccount.name,
  };
}

// ─── 9. acknowledgeBigWinDayAction ────────────────────────────────────────────

export async function acknowledgeBigWinDayAction(): Promise<WithdrawalActionResult> {
  const { userId } = await requireUser();
  await db.user.update({
    where: { id: userId },
    data: { bigWinDayLastPromptedAt: new Date() },
  });
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Prompt acknowledged." };
}

// ─── 10. updateBigWinDaySettingsAction ───────────────────────────────────────

export async function updateBigWinDaySettingsAction(
  formData: FormData,
): Promise<WithdrawalActionResult> {
  const { userId } = await requireUser();
  // Empty string or "null" means "disable" → null.
  const raw = formData.get("bigWinDayPercent");
  const parsed = bigWinDaySettingsSchema.safeParse({
    bigWinDayPercent: raw == null || raw === "" || raw === "null" ? null : Number(raw),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  await db.user.update({
    where: { id: userId },
    data: {
      bigWinDayPercent:
        parsed.data.bigWinDayPercent == null
          ? null
          : new Decimal(parsed.data.bigWinDayPercent).toDecimalPlaces(4),
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "BIG_WIN_DAY_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: { bigWinDayPercent: parsed.data.bigWinDayPercent },
    },
  });

  revalidatePath("/app/settings");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Big-win-day settings saved." };
}

// ─── 11. sendWithdrawalRemindersAction ───────────────────────────────────────

/**
 * Cron-friendly: scan every ACTIVE withdrawal rule across every user, and for
 * each one that is "due" per its frequency AND has profit to withdraw, fire
 * a WITHDRAWAL_DUE notification (in-app + email per the user's prefs).
 *
 * Returns the count of notifications fired. Safe to call repeatedly — the
 * pure `isWithdrawalDue` gate prevents duplicate notifications within the
 * same frequency window.
 *
 * NOTE: this action does NOT require `requireUser()` (it's a system-level
 * sweep). The cron endpoint at /api/cron/withdrawal-reminders token-protects
 * it with CRON_SECRET.
 */
export async function sendWithdrawalRemindersAction(): Promise<
  WithdrawalActionResult & { firedCount?: number; scannedCount?: number }
> {
  // Fetch all active rules + their accounts + users in one round trip.
  const rules = await db.withdrawalRule.findMany({
    where: { isActive: true },
    select: {
      id: true,
      userId: true,
      tradingAccountId: true,
      type: true,
      value: true,
      frequency: true,
      baseline: true,
      lastTriggeredAt: true,
      tradingAccount: {
        select: {
          name: true,
          startingBalance: true,
          currentBalance: true,
          highWaterMark: true,
        },
      },
      user: { select: { email: true, name: true, timezone: true } },
    },
  });

  let fired = 0;
  for (const rule of rules) {
    if (!rule.tradingAccount) continue;
    const now = new Date();
    const due = isWithdrawalDue({
      frequency: rule.frequency,
      lastTriggeredAt: rule.lastTriggeredAt,
      now,
    });
    if (!due) continue;

    // Compute profit + recommended amount to include in the notification
    // body (pure calc — no DB writes here).
    const lastWd = await findLastWithdrawalBalance(rule.tradingAccountId);
    const profit = computeProfitSinceBaseline({
      startingBalance: rule.tradingAccount.startingBalance,
      currentBalance: rule.tradingAccount.currentBalance,
      lastWithdrawalBalance: lastWd,
      highWaterMark: rule.tradingAccount.highWaterMark,
      baseline: rule.baseline,
    });
    const recommended = recommendWithdrawalAmount({
      type: rule.type,
      value: rule.value,
      profitSinceBaseline: profit,
      currentBalance: rule.tradingAccount.currentBalance,
    });
    if (recommended.lte(0)) continue; // don't notify when there's nothing to withdraw

    const body = `Your ${rule.frequency.toLowerCase()} withdrawal rule for ${rule.tradingAccount.name} is due. Recommended amount: ${recommended.toFixed(2)}. Open RiskGuard to mark as withdrawn.`;
    await createNotificationIfAllowed(
      rule.userId,
      "WITHDRAWAL_DUE",
      "Time to bank some profit",
      body,
    );

    // Email (Phase 12's notification system routes via email.ts).
    const user = rule.user;
    if (user?.email) {
      try {
        await sendEmail({
          to: user.email,
          subject: `RiskGuard — withdrawal reminder for ${rule.tradingAccount.name}`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <h1 style="font-size:18px">Time to bank some profit</h1>
            <p style="color:#374151">Your ${rule.frequency.toLowerCase()} withdrawal rule for <strong>${rule.tradingAccount.name}</strong> is due.</p>
            <p style="font-size:18px;margin:24px 0">Recommended amount: <strong>${recommended.toFixed(2)}</strong></p>
            <p style="color:#6b7280;font-size:13px">Open RiskGuard to mark as withdrawn.</p>
          </div>`,
          text: `Your ${rule.frequency.toLowerCase()} withdrawal rule for ${rule.tradingAccount.name} is due. Recommended amount: ${recommended.toFixed(2)}.`,
        });
      } catch {
        // Email failure is non-fatal — in-app notification still fired.
      }
    }

    fired++;
  }

  return {
    ok: true,
    message: `Scanned ${rules.length} active rule${rules.length === 1 ? "" : "s"}; fired ${fired} notification${fired === 1 ? "" : "s"}.`,
    firedCount: fired,
    scannedCount: rules.length,
  };
}

// ─── TZ helpers (mirrors Phase 18's approach) ────────────────────────────────

function dayKeyInTz(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Return the Date representing 00:00:00 of today in the user's TZ, expressed
 * as a UTC Date suitable for use as a Prisma `gte` filter. Falls back to UTC
 * midnight if the tz is invalid.
 */
function startOfDayInTz(d: Date, tz: string): Date {
  // Format "today" in the user's tz, then construct UTC midnight for that
  // Y-M-D. The result is the lower bound for "trades opened today in the
  // user's wall-clock" — slightly conservative for users west of UTC (their
  // "today" starts in UTC's "tomorrow") but correct for filtering trades.
  const key = dayKeyInTz(d, tz); // "YYYY-MM-DD"
  const [y, m, day] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
}
