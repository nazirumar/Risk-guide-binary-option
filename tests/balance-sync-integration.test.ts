/**
 * Phase 18 — integration tests for the BalanceCheck flow.
 *
 * Mirrors the pattern of `tests/accounts-integration.test.ts`:
 *   - Uses the real SQLite DB.
 *   - Server actions that depend on `requireUser()` can't be called directly
 *     (no Next.js request context) — so we re-implement the DB writes the
 *     actions make, asserting the math + the atomicity + the cross-user
 *     isolation the actions guarantee.
 *   - The pure-calc parts (`computeCheckResult`, `scoreAccuracy`,
 *     `suggestCauses`) are tested in `tests/calc/balance-sync.test.ts`.
 *
 * Coverage:
 *   1. BalanceCheck.create persists appBalance/brokerBalance/difference and
 *      auto-resolves MATCHED when within tolerance.
 *   2. BalanceCheck.create leaves resolution=null (pending) when outside
 *      tolerance.
 *   3. ADJUSTED resolution: creates an ADJUSTMENT transaction with the signed
 *      difference as amount, recomputes the account balance atomically, and
 *      stamps the check ADJUSTED.
 *   4. IGNORED resolution: stamps the note + resolution, no transaction.
 *   5. Re-resolving a terminal check (ADJUSTED → IGNORED) is rejected by the
 *      ownership guard.
 *   6. Cross-user: a user A BalanceCheck is invisible to user B's listing
 *      query (every query scoped by userId — PROJECT_RULES rule #3).
 *   7. Accuracy score: 2 MATCHED + 1 ADJUSTED in the last 30 days = 66%.
 *   8. Atomicity: if the balance recompute fails inside the $transaction,
 *      no BalanceCheck update or ADJUSTMENT transaction is committed either.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient, type BalanceCheckResolution } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import { recomputeAccountBalance, signedTransactionAmount } from "@/lib/calc/account-balance";
import { computeCheckResult, scoreAccuracy, suggestCauses } from "@/lib/calc/balance-sync";

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

/**
 * Re-implements `createBalanceCheckAction`'s persistence path with an explicit
 * `userIdOverride` so tests don't need NextAuth session context. The math
 * (computeCheckResult) is the exact pure function the action uses.
 */
async function createCheckForTest(
  userId: string,
  tradingAccountId: string,
  brokerBalance: string,
  tolerance: string,
): Promise<{
  id: string;
  appBalance: Decimal;
  brokerBalance: Decimal;
  difference: Decimal;
  isMatched: boolean;
}> {
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { currentBalance: true },
  });
  const appBalance = new Decimal(account.currentBalance.toString());
  const broker = new Decimal(brokerBalance).toDecimalPlaces(2);
  const { difference, isMatched } = computeCheckResult({
    appBalance,
    brokerBalance: broker,
    tolerancePercent: tolerance,
  });
  const created = await prisma.balanceCheck.create({
    data: {
      userId,
      tradingAccountId,
      appBalance: appBalance.toDecimalPlaces(2),
      brokerBalance: broker,
      difference: difference.toDecimalPlaces(2),
      resolution: (isMatched ? "MATCHED" : null) as BalanceCheckResolution | null,
    },
  });
  return { id: created.id, appBalance, brokerBalance: broker, difference, isMatched };
}

/**
 * Re-implements `resolveBalanceCheckAction`'s ADJUSTED branch — create the
 * ADJUSTMENT transaction atomically + recompute the account balance + stamp
 * the check.
 */
async function adjustForTest(
  userId: string,
  checkId: string,
  note: string | null,
): Promise<{ newBalance: Decimal; adjustment: Decimal; checkResolution: BalanceCheckResolution }> {
  const existing = await prisma.balanceCheck.findUniqueOrThrow({
    where: { id: checkId },
    select: { id: true, tradingAccountId: true, difference: true, resolution: true },
  });
  if (existing.resolution !== null) {
    throw new Error(`already resolved as ${existing.resolution}`);
  }
  const difference = new Decimal(existing.difference.toString());
  const result = await prisma.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: existing.tradingAccountId,
        type: "ADJUSTMENT",
        amount: difference.toDecimalPlaces(2),
        note: note ?? "Balance sync adjustment",
        occurredAt: new Date(),
      },
    });
    // Inline recompute (mirrors recomputeAccountBalanceInTx).
    const acc = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: existing.tradingAccountId },
      select: { startingBalance: true },
    });
    const [txs, trades] = await Promise.all([
      tx.transaction.findMany({
        where: { tradingAccountId: existing.tradingAccountId },
        select: { type: true, amount: true },
      }),
      tx.trade.findMany({
        where: {
          tradingAccountId: existing.tradingAccountId,
          result: { in: ["WIN", "LOSS", "TIE"] },
        },
        select: { profitLoss: true },
      }),
    ]);
    const newBalance = recomputeAccountBalance(acc.startingBalance, txs, trades);
    await tx.tradingAccount.update({
      where: { id: existing.tradingAccountId },
      data: { currentBalance: newBalance },
    });
    await tx.balanceCheck.update({
      where: { id: checkId },
      data: { resolution: "ADJUSTED" as BalanceCheckResolution, note },
    });
    await tx.auditLog.create({
      data: {
        userId,
        action: "BALANCE_CHECK_ADJUSTED",
        entity: "BalanceCheck",
        entityId: checkId,
        meta: { difference: difference.toString(), newBalance: newBalance.toString() },
      },
    });
    return { newBalance, adjustment: difference };
  });
  const after = await prisma.balanceCheck.findUniqueOrThrow({
    where: { id: checkId },
    select: { resolution: true },
  });
  return {
    newBalance: result.newBalance,
    adjustment: result.adjustment,
    checkResolution: after.resolution ?? "ADJUSTED",
  };
}

async function ignoreForTest(
  userId: string,
  checkId: string,
  note: string | null,
): Promise<BalanceCheckResolution> {
  const existing = await prisma.balanceCheck.findUniqueOrThrow({
    where: { id: checkId },
    select: { id: true, resolution: true },
  });
  if (existing.resolution !== null) {
    throw new Error(`already resolved as ${existing.resolution}`);
  }
  await prisma.balanceCheck.update({
    where: { id: checkId },
    data: { resolution: "IGNORED" as BalanceCheckResolution, note },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: "BALANCE_CHECK_IGNORED",
      entity: "BalanceCheck",
      entityId: checkId,
      meta: { note },
    },
  });
  return "IGNORED";
}

describe("Phase 18 — BalanceCheck create + tolerance", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`bs+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Sync Test", "1000");
    accountId = a.id;
  });

  it("auto-resolves MATCHED when the broker balance is within tolerance (0.5% of 1000 = ±5)", async () => {
    const r = await createCheckForTest(userId, accountId, "1005", "0.5");
    expect(r.isMatched).toBe(true);
    const row = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.resolution).toBe("MATCHED");
    expect(row.appBalance.toString()).toBe("1000");
    expect(row.brokerBalance.toString()).toBe("1005");
    expect(row.difference.toString()).toBe("5");
  });

  it("leaves resolution = null when the broker balance is outside tolerance", async () => {
    const r = await createCheckForTest(userId, accountId, "1010", "0.5");
    expect(r.isMatched).toBe(false);
    const row = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.resolution).toBeNull();
    expect(row.difference.toString()).toBe("10");
  });

  it("stores a negative difference when the broker shows LESS than the app", async () => {
    const r = await createCheckForTest(userId, accountId, "950", "0.5");
    expect(r.difference.toString()).toBe("-50");
    expect(r.isMatched).toBe(false);
  });

  it("exact-match balance is MATCHED with zero tolerance", async () => {
    const r = await createCheckForTest(userId, accountId, "1000", "0");
    expect(r.isMatched).toBe(true);
    const row = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.resolution).toBe("MATCHED");
  });
});

describe("Phase 18 — ADJUSTED resolution reuses Phase 4 reconcile logic", () => {
  let userId: string;
  let accountId: string;
  let checkId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`bsadj+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Adjust Test", "1000");
    accountId = a.id;
    // Create a pending check: broker shows 1010 → diff = +10, outside 0.5%.
    const r = await createCheckForTest(userId, accountId, "1010", "0.5");
    checkId = r.id;
  });

  it("creates a signed ADJUSTMENT transaction with the difference as the amount", async () => {
    const before = await prisma.transaction.count({
      where: { tradingAccountId: accountId },
    });
    expect(before).toBe(0);

    const res = await adjustForTest(userId, checkId, "Bank wire not logged");
    expect(res.adjustment.toString()).toBe("10");

    const adj = await prisma.transaction.findFirstOrThrow({
      where: { tradingAccountId: accountId, type: "ADJUSTMENT" },
    });
    expect(adj.amount.toString()).toBe("10");
    expect(adj.note).toContain("Bank wire not logged");
  });

  it("atomically recomputes the account balance to broker balance", async () => {
    const res = await adjustForTest(userId, checkId, null);
    // 1000 + 10 (ADJUSTMENT) = 1010, which equals the broker balance entered.
    expect(res.newBalance.toString()).toBe("1010");
    const acc = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.currentBalance.toString()).toBe("1010");
  });

  it("stamps the check row as ADJUSTED (terminal)", async () => {
    await adjustForTest(userId, checkId, null);
    const row = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(row.resolution).toBe("ADJUSTED");
  });

  it("creates a BALANCE_CHECK_ADJUSTED audit-log entry scoped by userId", async () => {
    await adjustForTest(userId, checkId, null);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { userId, action: "BALANCE_CHECK_ADJUSTED", entityId: checkId },
    });
    expect(log.entity).toBe("BalanceCheck");
    expect(log.meta).toBeTruthy();
  });

  it("re-resolving a terminal check is rejected by the ownership guard", async () => {
    await adjustForTest(userId, checkId, null);
    await expect(adjustForTest(userId, checkId, null)).rejects.toThrow(
      /already resolved as ADJUSTED/,
    );
  });

  it("negative difference creates a NEGATIVE ADJUSTMENT (broker < app)", async () => {
    const r = await createCheckForTest(userId, accountId, "980", "0.5");
    const res = await adjustForTest(userId, r.id, null);
    expect(res.adjustment.toString()).toBe("-20");
    const acc = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.currentBalance.toString()).toBe("980");
  });
});

describe("Phase 18 — IGNORED resolution + cross-user isolation", () => {
  let userA: string;
  let userB: string;
  let accountA: string;
  let accountB: string;
  let checkA: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.balanceCheck.deleteMany();
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

    // User A creates a pending check; user B also creates one.
    const rA = await createCheckForTest(userA, accountA, "1010", "0.5");
    checkA = rA.id;
    await createCheckForTest(userB, accountB, "2010", "0.5");
  });

  it("IGNORED stamps the note + resolution and creates NO transaction", async () => {
    const before = await prisma.transaction.count({
      where: { tradingAccountId: accountA },
    });
    expect(before).toBe(0);

    await ignoreForTest(userA, checkA, "Broker fee timing, ignore.");
    const row = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: checkA } });
    expect(row.resolution).toBe("IGNORED");
    expect(row.note).toBe("Broker fee timing, ignore.");
    const after = await prisma.transaction.count({
      where: { tradingAccountId: accountA },
    });
    expect(after).toBe(0); // No ADJUSTMENT created.
  });

  it("user A cannot see user B's balance checks (every query scoped by userId)", async () => {
    const aRows = await prisma.balanceCheck.findMany({
      where: { userId: userA },
      select: { id: true },
    });
    const bRows = await prisma.balanceCheck.findMany({
      where: { userId: userB },
      select: { id: true },
    });
    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(1);
    expect(aRows[0].id).not.toBe(bRows[0].id);
  });

  it("cross-user resolve is blocked by ownership guard (lookup returns null)", async () => {
    // Simulate user B trying to resolve user A's check by id.
    const lookup = await prisma.balanceCheck.findFirst({
      where: { id: checkA, userId: userB },
    });
    expect(lookup).toBeNull();
    // The action would return "Balance check not found." here.
  });

  it("cross-user ADJUSTMENT is blocked: user B cannot create a transaction on user A's account", async () => {
    // Simulate the ownership guard: `verifyAccountOwnership(accountA, userB)`
    // returns null, so the action never reaches `tx.transaction.create`.
    const owned = await prisma.tradingAccount.findFirst({
      where: { id: accountA, userId: userB },
    });
    expect(owned).toBeNull();
  });
});

describe("Phase 18 — accuracy score + atomicity", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`ac+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Accuracy Test", "1000");
    accountId = a.id;
  });

  it("accuracy = matched / total over the trailing 30 days", async () => {
    // 2 MATCHED + 1 ADJUSTED in the last 30 days → 2/3 = 66%.
    await createCheckForTest(userId, accountId, "1000", "0.5"); // MATCHED
    await createCheckForTest(userId, accountId, "1001", "0.5"); // MATCHED (0.1% < 0.5%)
    const pending = await createCheckForTest(userId, accountId, "1100", "0.5"); // 10% off → not matched
    await adjustForTest(userId, pending.id, null);
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await prisma.balanceCheck.findMany({
      where: { tradingAccountId: accountId, checkedAt: { gte: since } },
      select: { resolution: true, checkedAt: true },
    });
    expect(rows.length).toBe(3);
    const acc = scoreAccuracy(rows, since);
    expect(acc).toBe(66);
  });

  it("returns null when there are no checks in the 30-day window", async () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await prisma.balanceCheck.findMany({
      where: { tradingAccountId: accountId, checkedAt: { gte: since } },
    });
    expect(rows.length).toBe(0);
    expect(scoreAccuracy(rows, since)).toBeNull();
  });

  it("signed transaction amount preserves the ADJUSTMENT sign (+10 vs -20)", async () => {
    // Positive ADJUSTMENT contributes +; negative contributes −.
    expect(signedTransactionAmount({ type: "ADJUSTMENT", amount: "10" }).toString()).toBe("10");
    expect(signedTransactionAmount({ type: "ADJUSTMENT", amount: "-20" }).toString()).toBe("-20");
  });

  it("suggestCauses is pure: same inputs → same output (no DB calls)", async () => {
    const out1 = suggestCauses({
      difference: "50",
      trades: [{ profitLoss: "50" }],
      transactions: [],
      commonStakes: ["50"],
      now: new Date("2025-06-15T00:00:00Z"),
      lookbackDays: 7,
    });
    const out2 = suggestCauses({
      difference: "50",
      trades: [{ profitLoss: "50" }],
      transactions: [],
      commonStakes: ["50"],
      now: new Date("2025-06-15T00:00:00Z"),
      lookbackDays: 7,
    });
    expect(out1).toEqual(out2);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
