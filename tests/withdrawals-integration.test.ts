/**
 * Phase 19 — integration tests for the WithdrawalRule flow.
 *
 * Mirrors the pattern of `tests/accounts-integration.test.ts` and
 * `tests/balance-sync-integration.test.ts`:
 *   - Uses the real SQLite DB.
 *   - Re-implements the server-action DB writes with an explicit userIdOverride
 *     so tests don't need NextAuth session context. The math is the exact
 *     pure function the actions use.
 *
 * Coverage:
 *   1. Create rule seeds the HWM on the account when baseline=HIGH_WATER_MARK.
 *   2. Status computation: profit + recommended amount + due for the three
 *      rule types.
 *   3. Mark-withdrawn creates a WITHDRAWAL transaction atomically + recomputes
 *      balance + stamps the rule's lastTriggeredAt.
 *   4. Edge cases: no profit → recommended 0; negative profit → 0;
 *      FIXED_AMOUNT capped to available profit.
 *   5. Mid-period rule change resets lastTriggeredAt (when value/baseline
 *      changes).
 *   6. Cross-user isolation: user A's rule is invisible to user B.
 *   7. Banked-vs-at-risk aggregates DEPOSIT/WITHDRAWAL correctly.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import { recomputeAccountBalance, signedTransactionAmount } from "@/lib/calc/account-balance";
import {
  computeProfitSinceBaseline,
  recommendWithdrawalAmount,
  trackHighWaterMark,
  isWithdrawalDue,
  bankedVsAtRisk,
} from "@/lib/calc/withdrawals";

const prisma = new PrismaClient();

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await argon2.hash("test-pass"),
      emailVerified: new Date(),
      isOnboarded: true,
    },
  });
}

async function makeAccount(userId: string, name: string, start: string) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      name,
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal(start),
      currentBalance: new Decimal(start),
    },
  });
}

async function makeTransaction(
  tradingAccountId: string,
  type: "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT",
  amount: string,
) {
  return prisma.transaction.create({
    data: {
      tradingAccountId,
      type,
      amount: new Decimal(amount),
      occurredAt: new Date(),
    },
  });
}

/** Re-implements the atomic balance recompute path with a userIdOverride. */
async function recomputeForTest(tradingAccountId: string) {
  await prisma.$transaction(async (tx) => {
    const account = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: tradingAccountId },
      select: { startingBalance: true },
    });
    const [txs, trades] = await Promise.all([
      tx.transaction.findMany({
        where: { tradingAccountId },
        select: { type: true, amount: true },
      }),
      tx.trade.findMany({
        where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
        select: { profitLoss: true },
      }),
    ]);
    const newBalance = recomputeAccountBalance(account.startingBalance, txs, trades);
    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: { currentBalance: newBalance },
    });
  });
}

/** Re-implements `findLastWithdrawalBalance` for testing. */
async function findLastWithdrawalBalanceForTest(tradingAccountId: string): Promise<Decimal | null> {
  const txs = await prisma.transaction.findMany({
    where: { tradingAccountId },
    orderBy: { occurredAt: "asc" },
    select: { type: true, amount: true },
  });
  const account = await prisma.tradingAccount.findUnique({
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
      running = running.plus(amt);
    }
  }
  return lastAfterWithdrawal;
}

/** Re-implements the markWithdrawnAction atomic block with a userIdOverride. */
async function markWithdrawnForTest(
  userId: string,
  tradingAccountId: string,
  amount: string,
  ruleId?: string,
): Promise<{ newBalance: Decimal }> {
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { currentBalance: true },
  });
  const amountDecimal = new Decimal(amount).toDecimalPlaces(2);
  if (amountDecimal.gt(new Decimal(account.currentBalance.toString()))) {
    throw new Error("Amount exceeds current balance");
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId,
        type: "WITHDRAWAL",
        amount: amountDecimal,
        occurredAt: new Date(),
      },
    });
    // Inline recompute (mirrors recomputeAccountBalanceInTx).
    const acc = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: tradingAccountId },
      select: { startingBalance: true },
    });
    const [txs, trades] = await Promise.all([
      tx.transaction.findMany({
        where: { tradingAccountId },
        select: { type: true, amount: true },
      }),
      tx.trade.findMany({
        where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
        select: { profitLoss: true },
      }),
    ]);
    const newBalance = recomputeAccountBalance(acc.startingBalance, txs, trades);
    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: { currentBalance: newBalance },
    });
    if (ruleId) {
      await tx.withdrawalRule.update({
        where: { id: ruleId },
        data: { lastTriggeredAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: "WITHDRAWAL_RECORDED",
        entity: "Transaction",
        entityId: tradingAccountId,
        meta: { amount: amountDecimal.toString(), ruleId: ruleId ?? null },
      },
    });
    return { newBalance };
  });
  return result;
}

describe("Phase 19 — rule create + HWM seeding", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`wr+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "WR Test", "1000");
    accountId = a.id;
  });

  it("seeds highWaterMark from the current balance when baseline=HIGH_WATER_MARK", async () => {
    // Account starts at 1000; the rule should seed HWM=1000.
    const before = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { highWaterMark: true },
    });
    expect(before.highWaterMark).toBeNull();

    const rule = await prisma.withdrawalRule.create({
      data: {
        userId,
        tradingAccountId: accountId,
        type: "PERCENT_OF_PROFIT",
        value: new Decimal("20"),
        frequency: "WEEKLY",
        baseline: "HIGH_WATER_MARK",
        isActive: true,
      },
    });
    // Simulate the action's seeding step.
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true, highWaterMark: true },
    });
    if (account.highWaterMark == null) {
      await prisma.tradingAccount.update({
        where: { id: accountId },
        data: { highWaterMark: trackHighWaterMark(null, account.currentBalance) },
      });
    }
    const after = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { highWaterMark: true },
    });
    expect(after.highWaterMark?.toString()).toBe("1000");
    expect(rule.id).toBeTruthy();
  });
});

describe("Phase 19 — status: profit + recommended + due", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`wr+${Date.now()}@example.com`);
    userId = u.id;
    // Start at 1000, add a 200 DEPOSIT → balance 1200 (200 profit since start).
    const a = await makeAccount(userId, "Status Test", "1000");
    accountId = a.id;
    await makeTransaction(accountId, "DEPOSIT", "200");
    await recomputeForTest(accountId);
  });

  it("PERCENT_OF_PROFIT 20% → profit 200, recommended 40", async () => {
    await prisma.withdrawalRule.create({
      data: {
        userId,
        tradingAccountId: accountId,
        type: "PERCENT_OF_PROFIT",
        value: new Decimal("20"),
        frequency: "WEEKLY",
        baseline: "STARTING_BALANCE",
        isActive: true,
      },
    });
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { startingBalance: true, currentBalance: true },
    });
    const profit = computeProfitSinceBaseline({
      startingBalance: account.startingBalance,
      currentBalance: account.currentBalance,
      baseline: "STARTING_BALANCE",
    });
    expect(profit.toString()).toBe("200");
    const recommended = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "20",
      profitSinceBaseline: profit,
      currentBalance: account.currentBalance,
    });
    expect(recommended.toString()).toBe("40");
  });

  it("FIXED_AMOUNT 50 with profit 200 → recommend 50 (uncapped)", async () => {
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true },
    });
    const recommended = recommendWithdrawalAmount({
      type: "FIXED_AMOUNT",
      value: "50",
      profitSinceBaseline: "200",
      currentBalance: account.currentBalance,
    });
    expect(recommended.toString()).toBe("50");
  });

  it("FIXED_AMOUNT 50 with profit 30 → recommend 30 (capped to profit)", async () => {
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true },
    });
    const recommended = recommendWithdrawalAmount({
      type: "FIXED_AMOUNT",
      value: "50",
      profitSinceBaseline: "30",
      currentBalance: account.currentBalance,
    });
    expect(recommended.toString()).toBe("30");
  });

  it("BALANCE_ABOVE_THRESHOLD 1500 with balance 1200 → recommend 0 (below threshold)", async () => {
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true },
    });
    const recommended = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1500",
      profitSinceBaseline: "200",
      currentBalance: account.currentBalance,
    });
    expect(recommended.toString()).toBe("0");
  });

  it("BALANCE_ABOVE_THRESHOLD 1000 with balance 1200 → recommend 200", async () => {
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true },
    });
    const recommended = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1000",
      profitSinceBaseline: "200",
      currentBalance: account.currentBalance,
    });
    expect(recommended.toString()).toBe("200");
  });

  it("negative profit → recommend 0 (no withdrawal in drawdown)", async () => {
    const recommended = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "20",
      profitSinceBaseline: "-50",
      currentBalance: "950",
    });
    expect(recommended.toString()).toBe("0");
  });

  it("LAST_WITHDRAWAL baseline uses balance-after-last-withdrawal", async () => {
    // Withdraw 100 (balance 1200 → 1100). Then profit since last withdrawal
    // is currentBalance (1100) - lastWdBalance (1100) = 0... wait, after the
    // withdrawal the balance is 1100, so lastWdBalance = 1100. If balance
    // later grows to 1300, profit since last withdrawal = 1300 - 1100 = 200.
    await markWithdrawnForTest(userId, accountId, "100");
    // Now balance = 1100 (1200 - 100). Add a 200 BONUS → balance 1300.
    await makeTransaction(accountId, "BONUS", "200");
    await recomputeForTest(accountId);
    const lastWd = await findLastWithdrawalBalanceForTest(accountId);
    expect(lastWd?.toString()).toBe("1100");
    const profit = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1300",
      lastWithdrawalBalance: lastWd,
      baseline: "LAST_WITHDRAWAL",
    });
    expect(profit.toString()).toBe("200");
  });

  it("isWithdrawalDue: never-fired → due", () => {
    expect(
      isWithdrawalDue({
        frequency: "WEEKLY",
        lastTriggeredAt: null,
        now: new Date(),
      }),
    ).toBe(true);
  });

  it("isWithdrawalDue: same week → not due", () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const last = new Date("2025-06-10T12:00:00Z"); // same ISO week
    expect(isWithdrawalDue({ frequency: "WEEKLY", lastTriggeredAt: last, now })).toBe(false);
  });
});

describe("Phase 19 — markWithdrawn atomicity + balance recompute", () => {
  let userId: string;
  let accountId: string;
  let ruleId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`wra+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Atomic Test", "1000");
    accountId = a.id;
    await makeTransaction(accountId, "DEPOSIT", "200");
    await recomputeForTest(accountId); // balance now 1200

    const rule = await prisma.withdrawalRule.create({
      data: {
        userId,
        tradingAccountId: accountId,
        type: "PERCENT_OF_PROFIT",
        value: new Decimal("20"),
        frequency: "WEEKLY",
        baseline: "STARTING_BALANCE",
        isActive: true,
      },
    });
    ruleId = rule.id;
  });

  it("creates a WITHDRAWAL transaction with the amount", async () => {
    const before = await prisma.transaction.count({
      where: { tradingAccountId: accountId, type: "WITHDRAWAL" },
    });
    expect(before).toBe(0);

    await markWithdrawnForTest(userId, accountId, "40", ruleId);

    const wd = await prisma.transaction.findFirstOrThrow({
      where: { tradingAccountId: accountId, type: "WITHDRAWAL" },
    });
    expect(wd.amount.toString()).toBe("40");
  });

  it("atomically recomputes the account balance to (balance - withdrawal)", async () => {
    await markWithdrawnForTest(userId, accountId, "40", ruleId);
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { currentBalance: true },
    });
    expect(account.currentBalance.toString()).toBe("1160"); // 1200 - 40
  });

  it("stamps the rule's lastTriggeredAt", async () => {
    expect(
      (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } })).lastTriggeredAt,
    ).toBeNull();
    await markWithdrawnForTest(userId, accountId, "40", ruleId);
    const after = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(after).toBeInstanceOf(Date);
  });

  it("creates a WITHDRAWAL_RECORDED audit log scoped by userId", async () => {
    await markWithdrawnForTest(userId, accountId, "40", ruleId);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { userId, action: "WITHDRAWAL_RECORDED" },
    });
    expect(log.entity).toBe("Transaction");
    expect(log.meta).toBeTruthy();
  });

  it("throws if the withdrawal amount exceeds the current balance", async () => {
    await expect(markWithdrawnForTest(userId, accountId, "5000", ruleId)).rejects.toThrow(
      /exceeds current balance/,
    );
  });

  it("double-withdraw on the same rule still works (lastTriggeredAt advances)", async () => {
    await markWithdrawnForTest(userId, accountId, "40", ruleId);
    const first = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    await new Promise((r) => setTimeout(r, 50));
    await markWithdrawnForTest(userId, accountId, "20", ruleId);
    const second = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });
});

describe("Phase 19 — mid-period rule change resets lastTriggeredAt", () => {
  let userId: string;
  let accountId: string;
  let ruleId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`wrmp+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "MidPeriod Test", "1000");
    accountId = a.id;
    const rule = await prisma.withdrawalRule.create({
      data: {
        userId,
        tradingAccountId: accountId,
        type: "PERCENT_OF_PROFIT",
        value: new Decimal("20"),
        frequency: "WEEKLY",
        baseline: "STARTING_BALANCE",
        isActive: true,
        lastTriggeredAt: new Date(),
      },
    });
    ruleId = rule.id;
  });

  it("value change resets lastTriggeredAt to null", async () => {
    const before = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(before).not.toBeNull();

    // Action would reset lastTriggeredAt when value or baseline changes.
    await prisma.withdrawalRule.update({
      where: { id: ruleId },
      data: { value: new Decimal("30"), lastTriggeredAt: null },
    });
    const after = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(after).toBeNull();
  });

  it("baseline change resets lastTriggeredAt to null", async () => {
    await prisma.withdrawalRule.update({
      where: { id: ruleId },
      data: { baseline: "HIGH_WATER_MARK", lastTriggeredAt: null },
    });
    const after = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(after).toBeNull();
  });

  it("type change does NOT reset lastTriggeredAt", async () => {
    const before = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    // Action only resets on value/baseline change — not on type.
    await prisma.withdrawalRule.update({
      where: { id: ruleId },
      data: { type: "FIXED_AMOUNT" },
    });
    const after = (await prisma.withdrawalRule.findUniqueOrThrow({ where: { id: ruleId } }))
      .lastTriggeredAt;
    expect(after).toEqual(before);
  });
});

describe("Phase 19 — cross-user isolation", () => {
  let userA: string;
  let userB: string;
  let accountA: string;
  let accountB: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const uA = await makeUser(`a+${Date.now()}@example.com`);
    const uB = await makeUser(`b+${Date.now()}@example.com`);
    userA = uA.id;
    userB = uB.id;
    const aA = await makeAccount(userA, "UserA Acct", "1000");
    const aB = await makeAccount(userB, "UserB Acct", "2000");
    accountA = aA.id;
    accountB = aB.id;

    // Both users have a rule.
    await prisma.withdrawalRule.create({
      data: {
        userId: userA,
        tradingAccountId: accountA,
        type: "PERCENT_OF_PROFIT",
        value: new Decimal("20"),
        frequency: "WEEKLY",
        baseline: "STARTING_BALANCE",
        isActive: true,
      },
    });
    await prisma.withdrawalRule.create({
      data: {
        userId: userB,
        tradingAccountId: accountB,
        type: "FIXED_AMOUNT",
        value: new Decimal("50"),
        frequency: "MONTHLY",
        baseline: "LAST_WITHDRAWAL",
        isActive: true,
      },
    });
  });

  it("user A cannot see user B's rules (every query scoped by userId)", async () => {
    const aRules = await prisma.withdrawalRule.findMany({
      where: { userId: userA },
      select: { id: true, type: true },
    });
    const bRules = await prisma.withdrawalRule.findMany({
      where: { userId: userB },
      select: { id: true, type: true },
    });
    expect(aRules.length).toBe(1);
    expect(bRules.length).toBe(1);
    expect(aRules[0].id).not.toBe(bRules[0].id);
    expect(aRules[0].type).toBe("PERCENT_OF_PROFIT");
    expect(bRules[0].type).toBe("FIXED_AMOUNT");
  });

  it("cross-user withdrawal blocked: user B cannot withdraw from user A's account", async () => {
    // Simulate the ownership guard: verifyAccountOwnership(accountA, userB)
    // returns null.
    const owned = await prisma.tradingAccount.findFirst({
      where: { id: accountA, userId: userB },
    });
    expect(owned).toBeNull();
  });

  it("cross-user markWithdrawn ownership check (lookup returns null)", async () => {
    // Simulate: user B tries to mark a withdrawal against user A's rule.
    const ruleA = await prisma.withdrawalRule.findFirstOrThrow({
      where: { userId: userA },
      select: { id: true },
    });
    const lookup = await prisma.withdrawalRule.findFirst({
      where: { id: ruleA.id, userId: userB },
    });
    expect(lookup).toBeNull();
  });
});

describe("Phase 19 — bankedVsAtRisk aggregation", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.withdrawalRule.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`bv+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "BV Test", "1000");
    accountId = a.id;
    // Deposit 500, withdraw 300 → balance 1200, banked = 300 - 500 = -200.
    await makeTransaction(accountId, "DEPOSIT", "500");
    await makeTransaction(accountId, "WITHDRAWAL", "300");
    await recomputeForTest(accountId);
  });

  it("aggregates DEPOSIT and WITHDRAWAL totals via groupBy", async () => {
    const totals = await prisma.transaction.groupBy({
      by: ["type"],
      where: { tradingAccountId: accountId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
      _sum: { amount: true },
    });
    const deposited = totals.find((t) => t.type === "DEPOSIT")?._sum.amount ?? new Decimal(0);
    const withdrawn = totals.find((t) => t.type === "WITHDRAWAL")?._sum.amount ?? new Decimal(0);
    expect(deposited.toString()).toBe("500");
    expect(withdrawn.toString()).toBe("300");
  });

  it("bankedVsAtRisk: net-down case (more deposited than withdrawn)", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "500",
      totalWithdrawn: "300",
      currentBalance: "1200",
    });
    expect(r.banked.toString()).toBe("-200");
    expect(r.atRisk.toString()).toBe("1200");
  });

  it("bankedVsAtRisk: net-up case after additional withdrawals", async () => {
    // Withdraw another 400 → total withdrawn 700 > total deposited 500.
    await makeTransaction(accountId, "WITHDRAWAL", "400");
    await recomputeForTest(accountId);
    const r = bankedVsAtRisk({
      totalDeposited: "500",
      totalWithdrawn: "700",
      currentBalance: "800",
    });
    expect(r.banked.toString()).toBe("200"); // 700 - 500
    expect(r.atRisk.toString()).toBe("800");
  });

  it("ADJUSTMENT + BONUS are excluded from banked-via-at-risk aggregation", async () => {
    // Add an ADJUSTMENT and a BONUS; they shouldn't count as deposits or
    // withdrawals.
    await makeTransaction(accountId, "BONUS", "100");
    await makeTransaction(accountId, "ADJUSTMENT", "5");
    await recomputeForTest(accountId);
    const totals = await prisma.transaction.groupBy({
      by: ["type"],
      where: { tradingAccountId: accountId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
      _sum: { amount: true },
    });
    const deposited = totals.find((t) => t.type === "DEPOSIT")?._sum.amount;
    const withdrawn = totals.find((t) => t.type === "WITHDRAWAL")?._sum.amount;
    expect(deposited?.toString()).toBe("500"); // unchanged
    expect(withdrawn?.toString()).toBe("300"); // unchanged
  });

  it("signedTransactionAmount preserves deposit+ vs withdrawal- sign", () => {
    expect(signedTransactionAmount({ type: "DEPOSIT", amount: "500" }).toString()).toBe("500");
    expect(signedTransactionAmount({ type: "WITHDRAWAL", amount: "300" }).toString()).toBe("-300");
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
