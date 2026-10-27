"use server";

/**
 * Phase 4 — Trading Accounts server actions.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId. The `requireUser()`
 * helper returns the userId from the session — never trust a userId from form
 * data. Rule #1: all money math uses Decimal. Rule #9: every change is audit
 * -logged.
 *
 * The key correctness guarantee: TradingAccount.currentBalance is NEVER set
 * directly here. It is ALWAYS recomputed from
 *   startingBalance + Σ(transactions) + Σ(trade.profitLoss)
 * inside a `prisma.$transaction` (rule #1 of the Phase 4 spec).
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { recomputeAccountBalance } from "@/lib/calc/account-balance";
import { createTradingAccountSchema, updateTradingAccountSchema } from "@/lib/validation";
import { setActiveAccountId } from "@/server/actions/active-account";

export type AccountActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  accountId?: string;
};

// ─── Recompute balance — internal helper, called inside every transaction ──

/**
 * Atomic balance recompute for an account.
 *
 * Re-fetches ALL transactions + ALL trades-with-result for the account, sums
 * them with `recomputeAccountBalance()` from the pure calc module, and updates
 * `TradingAccount.currentBalance`. Also recomputes every trade's `balanceAfter`
 * (the equity walk) so Phase 5's journal + Phase 9's equity curve stay
 * consistent.
 *
 * MUST be called inside a `prisma.$transaction` — that's why it takes the
 * `tx` (transaction client) as a parameter rather than using the global `db`.
 */
export async function recomputeAccountBalanceInTx(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  tradingAccountId: string,
): Promise<{ newBalance: Decimal }> {
  const account = await tx.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { startingBalance: true },
  });
  if (!account) {
    throw new Error(`recomputeAccountBalanceInTx: account ${tradingAccountId} not found`);
  }

  const [transactions, trades] = await Promise.all([
    tx.transaction.findMany({
      where: { tradingAccountId },
      select: { type: true, amount: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    tx.trade.findMany({
      where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
      select: {
        id: true,
        profitLoss: true,
        openedAt: true,
      },
      orderBy: { openedAt: "asc" },
    }),
  ]);

  // Account-level balance
  const newBalance = recomputeAccountBalance(account.startingBalance, transactions, trades);

  await tx.tradingAccount.update({
    where: { id: tradingAccountId },
    data: { currentBalance: newBalance },
  });

  // Recompute the per-trade balanceAfter equity walk.
  // Walk in chronological order, running-balance = start + txSum + tradePL-so-far.
  const start = new Decimal(account.startingBalance.toString());
  const txSum = transactions.reduce(
    (acc, t) =>
      acc.plus(
        t.type === "WITHDRAWAL"
          ? new Decimal(t.amount.toString()).neg()
          : new Decimal(t.amount.toString()),
      ),
    new Decimal(0),
  );
  let running = start.plus(txSum);
  for (const trade of trades) {
    running = running.plus(new Decimal(trade.profitLoss.toString()));
    await tx.trade.update({
      where: { id: trade.id },
      data: { balanceAfter: running },
    });
  }

  return { newBalance };
}

// ─── Create trading account ───────────────────────────────────────────────

export async function createTradingAccountAction(formData: FormData): Promise<AccountActionResult> {
  const { userId } = await requireUser();
  const parsed = createTradingAccountSchema.safeParse({
    name: formData.get("name"),
    broker: formData.get("broker"),
    currency: String(formData.get("currency") ?? "").toUpperCase(),
    type: formData.get("type"),
    startingBalance: Number(formData.get("startingBalance") ?? 0),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const starting = new Decimal(parsed.data.startingBalance).toDecimalPlaces(2);

  // NOTE: we intentionally do NOT create a DEPOSIT transaction here.
  // `startingBalance` is the snapshot of the account at creation time, and
  // the recompute formula is `startingBalance + Σ(transactions) + Σ(trades)`.
  // Creating an extra DEPOSIT would double-count it: startingBalance + DEPOSIT
  // = 2× the starting amount. Subsequent deposits/withdrawals/bonuses are
  // separate money flows the user records via the transactions UI.
  const account = await db.$transaction(async (tx) => {
    const a = await tx.tradingAccount.create({
      data: {
        userId,
        name: parsed.data.name,
        broker: parsed.data.broker,
        currency: parsed.data.currency,
        type: parsed.data.type,
        startingBalance: starting,
        currentBalance: starting,
      },
    });
    // Recompute (no-op at this point: no transactions, no trades, will equal `starting`).
    // Kept so the formula is exercised on the very first create — if anyone
    // adds default transactions above later, the balance stays correct.
    await recomputeAccountBalanceInTx(tx, a.id);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADING_ACCOUNT_CREATED",
        entity: "TradingAccount",
        entityId: a.id,
        meta: {
          name: a.name,
          broker: a.broker,
          currency: a.currency,
          type: a.type,
          startingBalance: starting.toString(),
        },
      },
    });
    return a;
  });

  // Make the new account the active one so the user lands in it.
  await setActiveAccountId(account.id);

  revalidatePath("/app/accounts");
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `Account "${account.name}" created.`,
    accountId: account.id,
  };
}

// ─── Update trading account ─────────────────────────────────────────────────

export async function updateTradingAccountAction(formData: FormData): Promise<AccountActionResult> {
  const { userId } = await requireUser();
  const accountId = String(formData.get("tradingAccountId") ?? "");
  if (!accountId) {
    return { ok: false, message: "Missing account id." };
  }

  // Verify ownership FIRST — never trust the form for userId scoping.
  const owned = await db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!owned) {
    return { ok: false, message: "Account not found." };
  }

  const parsed = updateTradingAccountSchema.safeParse({
    name: formData.get("name") || undefined,
    broker: formData.get("broker") || undefined,
    currency: (formData.get("currency") as string | null)?.toUpperCase() || undefined,
    type: formData.get("type") || undefined,
    startingBalance: formData.get("startingBalance")
      ? Number(formData.get("startingBalance"))
      : undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.broker !== undefined) updates.broker = parsed.data.broker;
  if (parsed.data.currency !== undefined) updates.currency = parsed.data.currency;
  if (parsed.data.type !== undefined) updates.type = parsed.data.type;
  let startingChanged = false;
  if (parsed.data.startingBalance !== undefined) {
    updates.startingBalance = new Decimal(parsed.data.startingBalance).toDecimalPlaces(2);
    startingChanged = true;
  }

  await db.$transaction(async (tx) => {
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: updates,
    });
    // If starting balance changed, the running balance + every balanceAfter
    // must be recomputed. If anything else changed, no recompute needed.
    if (startingChanged) {
      await recomputeAccountBalanceInTx(tx, accountId);
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADING_ACCOUNT_UPDATED",
        entity: "TradingAccount",
        entityId: accountId,
        meta: JSON.parse(JSON.stringify(updates)) as never,
      },
    });
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${accountId}`);
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Account updated." };
}

// ─── Archive / restore ─────────────────────────────────────────────────────

export async function archiveTradingAccountAction(
  formData: FormData,
): Promise<AccountActionResult> {
  const { userId } = await requireUser();
  const accountId = String(formData.get("tradingAccountId") ?? "");
  if (!accountId) return { ok: false, message: "Missing account id." };

  // Verify ownership — scoped where clause means cross-user archive silently no-ops.
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.tradingAccount.updateMany({
      where: { id: accountId, userId, isArchived: false },
      data: { isArchived: true },
    });
    if (updated.count === 0) return null;
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADING_ACCOUNT_ARCHIVED",
        entity: "TradingAccount",
        entityId: accountId,
      },
    });
    return updated;
  });
  if (!result) return { ok: false, message: "Account not found or already archived." };

  revalidatePath("/app/accounts");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Account archived. History preserved." };
}

export async function restoreTradingAccountAction(
  formData: FormData,
): Promise<AccountActionResult> {
  const { userId } = await requireUser();
  const accountId = String(formData.get("tradingAccountId") ?? "");
  if (!accountId) return { ok: false, message: "Missing account id." };

  const result = await db.$transaction(async (tx) => {
    const updated = await tx.tradingAccount.updateMany({
      where: { id: accountId, userId, isArchived: true },
      data: { isArchived: false },
    });
    if (updated.count === 0) return null;
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRADING_ACCOUNT_RESTORED",
        entity: "TradingAccount",
        entityId: accountId,
      },
    });
    return updated;
  });
  if (!result) return { ok: false, message: "Account not found or not archived." };

  revalidatePath("/app/accounts");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Account restored." };
}
