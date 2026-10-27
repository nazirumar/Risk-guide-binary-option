"use server";

/**
 * Phase 4 — Transactions server actions + CSV export + reconcile balance.
 *
 * The atomic-balance guarantee: every action that mutates a transaction
 * wraps the change + balance recompute in `prisma.$transaction`, so
 * TradingAccount.currentBalance can never drift from
 *   startingBalance + Σ(transactions) + Σ(trade.profitLoss)
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { createTransactionSchema, reconcileBalanceSchema } from "@/lib/validation";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { reconcileDifference, withdrawalWouldExceedBalance } from "@/lib/calc/account-balance";

export type TransactionActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  warning?: string;
  newBalance?: string;
  difference?: string;
};

// ─── Pre-action ownership check ────────────────────────────────────────────

/**
 * Verifies that `accountId` belongs to the current user. Returns the
 * account's current state or null. Used as a guard at the top of every
 * account-scoped action.
 */
async function verifyOwnership(accountId: string, userId: string) {
  return db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true,
      name: true,
      currency: true,
      startingBalance: true,
      currentBalance: true,
      isArchived: true,
    },
  });
}

// ─── Create transaction ────────────────────────────────────────────────────

export async function createTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  const { userId } = await requireUser();
  const parsed = createTransactionSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    type: formData.get("type"),
    amount: Number(formData.get("amount") ?? 0),
    note: formData.get("note") || undefined,
    occurredAt: formData.get("occurredAt") || undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  // Ownership check — never trust accountId without scoping by userId.
  const account = await verifyOwnership(parsed.data.tradingAccountId, userId);
  if (!account) {
    return { ok: false, message: "Account not found." };
  }

  // Withdrawal warning (not a hard block — brokers allow overdraft in some
  // scenarios, and the trader may be intentionally recording a fee).
  let warning: string | undefined;
  if (
    parsed.data.type === "WITHDRAWAL" &&
    withdrawalWouldExceedBalance(account.currentBalance, parsed.data.amount)
  ) {
    warning = `Withdrawal of ${parsed.data.amount} exceeds the current balance of ${account.currentBalance}. This will push the balance negative — make sure this matches your broker.`;
  }

  const occurredAt =
    parsed.data.occurredAt instanceof Date
      ? parsed.data.occurredAt
      : parsed.data.occurredAt
        ? new Date(parsed.data.occurredAt)
        : new Date();

  if (Number.isNaN(occurredAt.getTime())) {
    return {
      ok: false,
      message: "Invalid date.",
      fieldErrors: { occurredAt: "Enter a valid date." },
    };
  }

  const amountDecimal = new Decimal(parsed.data.amount).toDecimalPlaces(2);

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: parsed.data.tradingAccountId,
        type: parsed.data.type,
        amount: amountDecimal,
        note: parsed.data.note ?? null,
        occurredAt,
      },
    });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, parsed.data.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRANSACTION_CREATED",
        entity: "Transaction",
        entityId: parsed.data.tradingAccountId,
        meta: {
          type: parsed.data.type,
          amount: amountDecimal.toString(),
          occurredAt: occurredAt.toISOString(),
          note: parsed.data.note ?? null,
        },
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${parsed.data.tradingAccountId}`);
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `${parsed.data.type.toLowerCase().charAt(0).toUpperCase() + parsed.data.type.toLowerCase().slice(1)} recorded. New balance: ${newBalance.toFixed(2)}.`,
    warning,
    newBalance: newBalance.toString(),
  };
}

// ─── Delete transaction ─────────────────────────────────────────────────────

export async function deleteTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  const { userId } = await requireUser();
  const transactionId = String(formData.get("transactionId") ?? "");
  if (!transactionId) return { ok: false, message: "Missing transaction id." };

  // First find the transaction + verify ownership via the account's userId.
  const tx0 = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      tradingAccountId: true,
      tradingAccount: { select: { userId: true } },
    },
  });
  if (!tx0 || tx0.tradingAccount.userId !== userId) {
    return { ok: false, message: "Transaction not found." };
  }

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.transaction.delete({ where: { id: transactionId } });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, tx0.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "TRANSACTION_DELETED",
        entity: "Transaction",
        entityId: transactionId,
        meta: { tradingAccountId: tx0.tradingAccountId },
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${tx0.tradingAccountId}`);
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `Transaction deleted. New balance: ${newBalance.toFixed(2)}.`,
    newBalance: newBalance.toString(),
  };
}

// ─── Reconcile balance ─────────────────────────────────────────────────────

/**
 * Compute the difference between our computed balance and the broker's
 * real balance. Returns the difference so the UI can show "you're off by
 * $X.XX — create an ADJUSTMENT?" before the user confirms.
 */
export async function previewReconcileAction(
  formData: FormData,
): Promise<TransactionActionResult & { difference: string; computedBalance: string }> {
  const { userId } = await requireUser();
  const parsed = reconcileBalanceSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    brokerBalance: Number(formData.get("brokerBalance") ?? 0),
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
      difference: "0",
      computedBalance: "0",
    };
  }

  const account = await verifyOwnership(parsed.data.tradingAccountId, userId);
  if (!account) {
    return {
      ok: false,
      message: "Account not found.",
      difference: "0",
      computedBalance: "0",
    };
  }

  const computed = account.currentBalance;
  const difference = reconcileDifference(computed, parsed.data.brokerBalance);
  return {
    ok: true,
    message: difference.isZero()
      ? "Our books match the broker's balance — no adjustment needed."
      : difference.gt(0)
        ? `Broker shows ${difference.toFixed(2)} more than our books. A positive adjustment will be created.`
        : `Broker shows ${difference.abs().toFixed(2)} less than our books. A negative adjustment will be created.`,
    difference: difference.toString(),
    computedBalance: computed.toString(),
  };
}

/**
 * Confirm the reconcile: create the ADJUSTMENT transaction atomically with
 * the balance recompute. The amount is the signed difference.
 */
export async function confirmReconcileAction(formData: FormData): Promise<TransactionActionResult> {
  const { userId } = await requireUser();
  const parsed = reconcileBalanceSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    brokerBalance: Number(formData.get("brokerBalance") ?? 0),
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

  const account = await verifyOwnership(parsed.data.tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  const difference = reconcileDifference(account.currentBalance, parsed.data.brokerBalance);
  if (difference.isZero()) {
    return { ok: true, message: "Already in sync — no adjustment needed." };
  }

  const { newBalance } = await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: parsed.data.tradingAccountId,
        type: "ADJUSTMENT",
        amount: difference.toDecimalPlaces(2),
        note:
          parsed.data.note ??
          `Reconciled against broker statement (${parsed.data.brokerBalance.toFixed(2)})`,
        occurredAt: new Date(),
      },
    });
    const { newBalance } = await recomputeAccountBalanceInTx(tx, parsed.data.tradingAccountId);
    await tx.auditLog.create({
      data: {
        userId,
        action: "BALANCE_RECONCILED",
        entity: "TradingAccount",
        entityId: parsed.data.tradingAccountId,
        meta: {
          brokerBalance: parsed.data.brokerBalance.toFixed(2),
          computedBefore: account.currentBalance.toString(),
          adjustment: difference.toString(),
          computedAfter: newBalance.toString(),
        },
      },
    });
    return { newBalance };
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${parsed.data.tradingAccountId}`);
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: `Balance reconciled. Adjustment of ${difference.toFixed(2)} recorded. New balance: ${newBalance.toFixed(2)}.`,
    newBalance: newBalance.toString(),
  };
}

// ─── CSV export ─────────────────────────────────────────────────────────────

/**
 * Returns a CSV string of the account's transactions. The caller (Route
 * Handler) sets the appropriate Content-Type + Content-Disposition headers.
 */
export async function exportTransactionsCSVAction(
  tradingAccountId: string,
): Promise<{ ok: boolean; csv?: string; filename?: string; message?: string }> {
  const { userId } = await requireUser();
  const account = await verifyOwnership(tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  const transactions = await db.transaction.findMany({
    where: { tradingAccountId },
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      type: true,
      amount: true,
      note: true,
      occurredAt: true,
      createdAt: true,
    },
  });

  const escapeCSV = (s: unknown) => {
    const str = String(s ?? "");
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = ["Date", "Type", "Amount", "Note", "Created (ISO)"];
  const rows = transactions.map((t) =>
    [
      t.occurredAt.toISOString().slice(0, 10),
      t.type,
      t.amount.toString(),
      t.note ?? "",
      t.createdAt.toISOString(),
    ]
      .map(escapeCSV)
      .join(","),
  );
  const csv = [header.join(","), ...rows].join("\r\n");

  const safeName = account.name.replace(/[^a-zA-Z0-9-_]/g, "_");
  const filename = `riskguard-${safeName}-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  return { ok: true, csv, filename };
}
