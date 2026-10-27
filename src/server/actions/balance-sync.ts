"use server";

/**
 * Phase 18 — Broker Balance Sync Checks server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #4: Zod on
 * the server. rule #1: money as Decimal. rule #8: state changes are audited.)
 *
 * Five actions + two pure-DB helpers:
 *
 *   - `createBalanceCheckAction`     — user enters the broker balance; the
 *                                       server reads the app balance, computes
 *                                       the difference, persists a
 *                                       BalanceCheck row (auto-resolves
 *                                       MATCHED when within tolerance), and
 *                                       returns the row + computed summary so
 *                                       the dialog can render the result.
 *
 *   - `resolveBalanceCheckAction`    — resolves a pending check. ADJUSTED
 *                                       creates an ADJUSTMENT transaction
 *                                       atomically (re-uses Phase 4's
 *                                       `recomputeAccountBalanceInTx`) +
 *                                       stamps the check ADJUSTED; IGNORED just
 *                                       stamps the note + resolution. Both
 *                                       write an audit-log row.
 *
 *   - `listBalanceChecksAction`      — history page query, filtered by
 *                                       account + resolution + date range.
 *                                       Returns rows scoped by userId.
 *
 *   - `getAccountAccuracyAction`     — returns the trailing 30-day MATCHED
 *                                       share for an account (null = no data).
 *
 *   - `shouldPromptBalanceCheckAction`— true iff the user's reminder
 *                                       frequency + last-prompted time say the
 *                                       banner should show now. Also returns
 *                                       the active account id (so the banner
 *                                       can target it without a second call).
 *
 *   - `markBalanceCheckPromptedAction`— stamps `balanceSyncLastPromptedAt =
 *                                       now` so the same session doesn't
 *                                       re-prompt; also revalidates dashboard.
 *
 *   - `updateBalanceSyncSettingsAction`— persists tolerance + frequency.
 *
 * NOTE: a "use server" file may only export async functions — non-async
 * types/helpers live in `./balance-sync-types.ts`.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import {
  createBalanceCheckSchema,
  resolveBalanceCheckSchema,
  balanceSyncSettingsSchema,
} from "@/lib/validation";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { getActiveAccountId } from "@/server/actions/active-account";
import { computeCheckResult, suggestCauses, scoreAccuracy } from "@/lib/calc/balance-sync";
import type { CauseSuggestion } from "@/lib/calc/balance-sync";

export type BalanceCheckResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type CreateBalanceCheckResult = BalanceCheckResult & {
  checkId?: string;
  appBalance?: string;
  brokerBalance?: string;
  difference?: string;
  percentDiff?: string;
  isMatched?: boolean;
  resolution?: "MATCHED" | "ADJUSTED" | "IGNORED" | null;
  causes?: CauseSuggestion[];
};

export type ResolveBalanceCheckResult = BalanceCheckResult & {
  newBalance?: string;
  resolution?: "MATCHED" | "ADJUSTED" | "IGNORED";
};

export type BalanceCheckRow = {
  id: string;
  tradingAccountId: string;
  accountName: string;
  appBalance: string;
  brokerBalance: string;
  difference: string;
  resolution: "MATCHED" | "ADJUSTED" | "IGNORED" | null;
  note: string | null;
  checkedAt: Date;
};

export type ListBalanceChecksResult = BalanceCheckResult & {
  rows?: BalanceCheckRow[];
  totalCount?: number;
};

export type AccuracyResult = BalanceCheckResult & {
  accuracy?: number | null;
  totalChecks?: number;
  matchedChecks?: number;
};

export type ShouldPromptResult = BalanceCheckResult & {
  shouldPrompt?: boolean;
  tradingAccountId?: string | null;
  accountName?: string;
};

export type BalanceSyncSettingsResult = BalanceCheckResult;

// ─── Ownership check (mirrors `verifyOwnership` in transactions.ts) ─────────

async function verifyAccountOwnership(accountId: string, userId: string) {
  return db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true,
      name: true,
      currency: true,
      currentBalance: true,
    },
  });
}

async function verifyCheckOwnership(checkId: string, userId: string) {
  return db.balanceCheck.findFirst({
    where: { id: checkId, userId },
    select: {
      id: true,
      tradingAccountId: true,
      appBalance: true,
      brokerBalance: true,
      difference: true,
      resolution: true,
      tradingAccount: { select: { name: true, userId: true } },
    },
  });
}

// ─── 1. createBalanceCheckAction ────────────────────────────────────────────

export async function createBalanceCheckAction(
  formData: FormData,
): Promise<CreateBalanceCheckResult> {
  const { userId } = await requireUser();
  const parsed = createBalanceCheckSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    brokerBalance: Number(formData.get("brokerBalance") ?? 0),
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

  // Fetch the user's tolerance setting (Phase 18 field on User).
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { balanceSyncTolerancePercent: true },
  });
  const tolerance = user?.balanceSyncTolerancePercent ?? new Decimal("0.5");

  const appBalance = new Decimal(account.currentBalance.toString());
  const brokerBalance = new Decimal(parsed.data.brokerBalance).toDecimalPlaces(2);
  const { difference, percentDiff, isMatched } = computeCheckResult({
    appBalance,
    brokerBalance,
    tolerancePercent: tolerance,
  });

  // Pre-compute "possible causes" so the dialog can show them immediately
  // when the check is NOT matched. Only run when there's a non-zero
  // difference (computeCheckResult.isMatched already short-circuits zero).
  let causes: CauseSuggestion[] = [];
  if (!isMatched && !difference.isZero()) {
    const lookbackDays = 7;
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const [recentTrades, recentTransactions, stakeTrades] = await Promise.all([
      db.trade.findMany({
        where: {
          userId,
          tradingAccountId: account.id,
          openedAt: { gte: cutoff },
          result: { in: ["WIN", "LOSS", "TIE"] },
        },
        select: {
          profitLoss: true,
          stake: true,
          payoutPercent: true,
          openedAt: true,
          closedAt: true,
          result: true,
        },
      }),
      db.transaction.findMany({
        where: { tradingAccountId: account.id, occurredAt: { gte: cutoff } },
        select: { type: true, amount: true, occurredAt: true },
      }),
      db.trade.findMany({
        where: {
          userId,
          tradingAccountId: account.id,
          openedAt: { gte: cutoff },
        },
        select: { stake: true },
        take: 50,
        orderBy: { openedAt: "desc" },
      }),
    ]);
    causes = suggestCauses({
      difference,
      trades: recentTrades.map((t) => ({
        profitLoss: t.profitLoss.toString(),
        stake: t.stake.toString(),
        payoutPercent: t.payoutPercent.toString(),
        openedAt: t.openedAt ?? undefined,
        closedAt: t.closedAt ?? undefined,
        result: t.result ?? undefined,
      })),
      transactions: recentTransactions.map((t) => ({
        type: t.type,
        amount: t.amount.toString(),
        occurredAt: t.occurredAt ?? undefined,
      })),
      commonStakes: stakeTrades.map((t) => t.stake.toString()),
      now: new Date(),
      lookbackDays,
    });
  }

  // Persist the check row. Auto-resolve MATCHED checks immediately — they
  // are terminal. Non-matched checks are persisted with `resolution = null`
  // (pending); the user then picks ADJUSTED or IGNORED from the dialog via
  // `resolveBalanceCheckAction`. We deliberately do not model a 4th "PENDING"
  // enum value to keep the user-facing enum at exactly the three resolutions
  // specified in the Phase 18 brief — null IS the pending state, by convention.
  const created = await db.balanceCheck.create({
    data: {
      userId,
      tradingAccountId: account.id,
      appBalance: appBalance.toDecimalPlaces(2),
      brokerBalance,
      difference: difference.toDecimalPlaces(2),
      resolution: isMatched ? "MATCHED" : null,
      note: null,
      checkedAt: new Date(),
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "BALANCE_CHECK_CREATED",
      entity: "BalanceCheck",
      entityId: created.id,
      meta: {
        tradingAccountId: account.id,
        appBalance: appBalance.toString(),
        brokerBalance: brokerBalance.toString(),
        difference: difference.toString(),
        percentDiff: percentDiff.toString(),
        tolerance: tolerance.toString(),
        matched: isMatched,
      },
    },
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${account.id}`);
  revalidatePath("/app/balance-sync");
  revalidatePath("/app/dashboard");

  return {
    ok: true,
    message: isMatched
      ? `Matched — broker balance is within ${tolerance.toFixed(2)}% of our books.`
      : `Mismatch detected — broker is ${difference.abs().toFixed(2)} ${difference.gt(0) ? "ahead" : "behind"} our books (${percentDiff.toFixed(2)}% off).`,
    checkId: created.id,
    appBalance: appBalance.toString(),
    brokerBalance: brokerBalance.toString(),
    difference: difference.toString(),
    percentDiff: percentDiff.toString(),
    isMatched,
    resolution: created.resolution,
    causes,
  };
}

// ─── 2. resolveBalanceCheckAction ───────────────────────────────────────────

export async function resolveBalanceCheckAction(
  formData: FormData,
): Promise<ResolveBalanceCheckResult> {
  const { userId } = await requireUser();
  const parsed = resolveBalanceCheckSchema.safeParse({
    checkId: formData.get("checkId"),
    resolution: formData.get("resolution"),
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

  const existing = await verifyCheckOwnership(parsed.data.checkId, userId);
  if (!existing) {
    return { ok: false, message: "Balance check not found." };
  }
  // Only pending checks (resolution = null) can be resolved. MATCHED rows
  // are auto-terminal at creation; ADJUSTED/IGNORED rows are terminal once
  // the user picks a resolution. Re-resolving is rejected.
  if (existing.resolution !== null) {
    return {
      ok: false,
      message: `This check has already been resolved as ${existing.resolution}.`,
    };
  }

  const difference = new Decimal(existing.difference.toString());
  // Already-matched-by-tolerance AND zero difference: there's nothing to
  // adjust — the user shouldn't reach here, but be defensive anyway.
  if (parsed.data.resolution === "ADJUSTED" && difference.isZero()) {
    await db.balanceCheck.update({
      where: { id: existing.id },
      data: { resolution: "ADJUSTED", note: parsed.data.note ?? null },
    });
    return {
      ok: true,
      message: "Difference was zero — no adjustment needed. Check marked as resolved.",
      resolution: "ADJUSTED",
    };
  }

  if (parsed.data.resolution === "ADJUSTED") {
    // Re-use Phase 4's reconcile path: create an ADJUSTMENT transaction with
    // the signed difference as the amount, then atomically recompute the
    // account balance. This guarantee the new currentBalance is consistent
    // with the startingBalance + Σ(transactions) + Σ(trades) formula.
    const result = await db.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          tradingAccountId: existing.tradingAccountId,
          type: "ADJUSTMENT",
          amount: difference.toDecimalPlaces(2),
          note:
            parsed.data.note ??
            `Balance sync adjustment (broker ${existing.brokerBalance.toString()} vs app ${existing.appBalance.toString()})`,
          occurredAt: new Date(),
        },
      });
      const { newBalance } = await recomputeAccountBalanceInTx(tx, existing.tradingAccountId);
      await tx.balanceCheck.update({
        where: { id: existing.id },
        data: {
          resolution: "ADJUSTED",
          note: parsed.data.note ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "BALANCE_CHECK_ADJUSTED",
          entity: "BalanceCheck",
          entityId: existing.id,
          meta: {
            tradingAccountId: existing.tradingAccountId,
            appBalance: existing.appBalance.toString(),
            brokerBalance: existing.brokerBalance.toString(),
            difference: difference.toString(),
            adjustment: difference.toString(),
            computedAfter: newBalance.toString(),
            note: parsed.data.note ?? null,
          },
        },
      });
      return { newBalance };
    });

    revalidatePath("/app/accounts");
    revalidatePath(`/app/accounts/${existing.tradingAccountId}`);
    revalidatePath("/app/balance-sync");
    revalidatePath("/app/dashboard");
    return {
      ok: true,
      message: `Adjustment of ${difference.toFixed(2)} recorded. New balance: ${result.newBalance.toFixed(2)}.`,
      newBalance: result.newBalance.toString(),
      resolution: "ADJUSTED",
    };
  }

  // IGNORED — just stamp the note + resolution; no transaction is created.
  await db.balanceCheck.update({
    where: { id: existing.id },
    data: {
      resolution: "IGNORED",
      note: parsed.data.note ?? null,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "BALANCE_CHECK_IGNORED",
      entity: "BalanceCheck",
      entityId: existing.id,
      meta: {
        tradingAccountId: existing.tradingAccountId,
        appBalance: existing.appBalance.toString(),
        brokerBalance: existing.brokerBalance.toString(),
        difference: difference.toString(),
        note: parsed.data.note ?? null,
      },
    },
  });

  revalidatePath("/app/accounts");
  revalidatePath(`/app/accounts/${existing.tradingAccountId}`);
  revalidatePath("/app/balance-sync");
  revalidatePath("/app/dashboard");
  return {
    ok: true,
    message: "Mismatch ignored with note. No adjustment created.",
    resolution: "IGNORED",
  };
}

// ─── 3. listBalanceChecksAction ──────────────────────────────────────────────

export async function listBalanceChecksAction(input: {
  tradingAccountId?: string;
  /** Accepts "PENDING" as a sentinel to filter null-resolution rows. */
  resolution?: "MATCHED" | "ADJUSTED" | "IGNORED" | "PENDING";
  fromIso?: string;
  toIso?: string;
}): Promise<ListBalanceChecksResult> {
  const { userId } = await requireUser();
  const where: {
    userId: string;
    tradingAccountId?: string;
    resolution?: "MATCHED" | "ADJUSTED" | "IGNORED" | null;
    checkedAt?: { gte?: Date; lte?: Date };
  } = { userId };
  if (input.tradingAccountId) where.tradingAccountId = input.tradingAccountId;
  if (input.resolution) {
    // "PENDING" sentinel → filter rows where resolution IS NULL.
    where.resolution = input.resolution === "PENDING" ? null : input.resolution;
  }
  if (input.fromIso || input.toIso) {
    where.checkedAt = {};
    if (input.fromIso) where.checkedAt.gte = new Date(input.fromIso);
    if (input.toIso) where.checkedAt.lte = new Date(input.toIso);
  }

  const [rows, totalCount] = await Promise.all([
    db.balanceCheck.findMany({
      where,
      orderBy: { checkedAt: "desc" },
      take: 200,
      select: {
        id: true,
        tradingAccountId: true,
        appBalance: true,
        brokerBalance: true,
        difference: true,
        resolution: true,
        note: true,
        checkedAt: true,
        tradingAccount: { select: { name: true } },
      },
    }),
    db.balanceCheck.count({ where }),
  ]);

  return {
    ok: true,
    message: `${rows.length} check${rows.length === 1 ? "" : "s"} found.`,
    totalCount,
    rows: rows.map((r) => ({
      id: r.id,
      tradingAccountId: r.tradingAccountId,
      accountName: r.tradingAccount?.name ?? "—",
      appBalance: r.appBalance.toString(),
      brokerBalance: r.brokerBalance.toString(),
      difference: r.difference.toString(),
      resolution: r.resolution,
      note: r.note,
      checkedAt: r.checkedAt,
    })),
  };
}

// ─── 4. getAccountAccuracyAction ────────────────────────────────────────────

export async function getAccountAccuracyAction(tradingAccountId: string): Promise<AccuracyResult> {
  const { userId } = await requireUser();
  const account = await verifyAccountOwnership(tradingAccountId, userId);
  if (!account) return { ok: false, message: "Account not found." };

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db.balanceCheck.findMany({
    where: { tradingAccountId, checkedAt: { gte: since } },
    select: { resolution: true, checkedAt: true },
  });
  const accuracy = scoreAccuracy(rows, since);
  const matchedChecks = rows.filter((r) => r.resolution === "MATCHED").length;
  return {
    ok: true,
    message:
      accuracy === null
        ? "No balance checks in the last 30 days."
        : `${accuracy}% of last 30 days' checks matched (${matchedChecks}/${rows.length}).`,
    accuracy,
    totalChecks: rows.length,
    matchedChecks,
  };
}

// ─── 5. shouldPromptBalanceCheckAction ───────────────────────────────────────

export async function shouldPromptBalanceCheckAction(): Promise<ShouldPromptResult> {
  const { userId } = await requireUser();
  const activeId = await getActiveAccountId();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      balanceSyncReminderFrequency: true,
      balanceSyncLastPromptedAt: true,
      timezone: true,
    },
  });
  const freq = user?.balanceSyncReminderFrequency ?? "DAILY";
  if (freq === "OFF" || !activeId) {
    return { ok: true, message: "Reminder off or no active account.", shouldPrompt: false };
  }

  const now = new Date();
  const last = user?.balanceSyncLastPromptedAt ?? null;

  // DAY-level comparison in the user's timezone (the spec says "first login
  // of the day" — we honour the trader's wall-clock, not UTC).
  const tz = user?.timezone ?? "UTC";
  const todayStr = inTzDayKey(now, tz);
  const lastStr = last ? inTzDayKey(last, tz) : null;

  let shouldPrompt = false;
  if (freq === "DAILY") {
    shouldPrompt = todayStr !== lastStr;
  } else if (freq === "WEEKLY") {
    // Compare ISO week-of-year (locale-independent).
    shouldPrompt = isoWeek(now, tz) !== (last ? isoWeek(last, tz) : null);
  }

  const account = await db.tradingAccount.findUnique({
    where: { id: activeId },
    select: { name: true },
  });

  return {
    ok: true,
    message: shouldPrompt ? "Time to verify your broker balance." : "Already prompted.",
    shouldPrompt,
    tradingAccountId: activeId,
    accountName: account?.name ?? "your account",
  };
}

// ─── 6. markBalanceCheckPromptedAction ───────────────────────────────────────

export async function markBalanceCheckPromptedAction(): Promise<BalanceCheckResult> {
  const { userId } = await requireUser();
  await db.user.update({
    where: { id: userId },
    data: { balanceSyncLastPromptedAt: new Date() },
  });
  // No audit log — this is a display-cookie, not a state change.
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Prompt acknowledged." };
}

// ─── 7. updateBalanceSyncSettingsAction ─────────────────────────────────────

export async function updateBalanceSyncSettingsAction(
  formData: FormData,
): Promise<BalanceSyncSettingsResult> {
  const { userId } = await requireUser();
  const parsed = balanceSyncSettingsSchema.safeParse({
    tolerancePercent: Number(formData.get("tolerancePercent") ?? 0.5),
    reminderFrequency: formData.get("reminderFrequency") ?? "DAILY",
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
      balanceSyncTolerancePercent: new Decimal(parsed.data.tolerancePercent).toDecimalPlaces(4),
      balanceSyncReminderFrequency: parsed.data.reminderFrequency,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "BALANCE_SYNC_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: {
        tolerancePercent: parsed.data.tolerancePercent,
        reminderFrequency: parsed.data.reminderFrequency,
      },
    },
  });

  revalidatePath("/app/settings");
  revalidatePath("/app/dashboard");
  return { ok: true, message: "Balance sync settings saved." };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a Date to its YYYY-MM-DD key in the given IANA timezone using
 * `Intl.DateTimeFormat`. Falls back to UTC if the tz is invalid.
 */
function inTzDayKey(d: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d); // "YYYY-MM-DD"
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * ISO 8601 week-of-year + year (e.g. "2025-W24"). Uses the user's timezone so
 * "first login of the week" means the user's wall-clock week, not UTC.
 * Implementation: format the Y-M-D in tz, build a Date, then compute ISO week
 * (no `Intl.DateTimeFormat(...{ week: ... })` because TS lib doesn't include
 * that option — we synthesize it from the calendar date).
 */
function isoWeek(d: Date, tz: string): string {
  const dayKey = inTzDayKey(d, tz); // "YYYY-MM-DD"
  const [y, m, day] = dayKey.split("-").map(Number);
  const local = new Date(Date.UTC(y, m - 1, day));
  const dayNum = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - dayNum + 3); // move to Thursday (ISO anchor)
  const firstThursday = new Date(Date.UTC(local.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round((local.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
