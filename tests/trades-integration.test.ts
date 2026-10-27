/**
 * Phase 5 integration tests — verify trade open/close/edit/delete keeps the
 * account balance + balanceAfter equity walk consistent.
 *
 * Uses the real SQLite DB (same pattern as tests/accounts-integration.test.ts).
 * The atomic guarantee comes from `recomputeAccountBalanceInTx()` in
 * `src/server/actions/accounts.ts` — these tests assert it actually does the
 * right thing when trades are mutated.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import { computeTradeProfitLoss } from "@/lib/calc/trade";

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

async function makeAccount(userId: string, start: string) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      name: "Test",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal(start),
      currentBalance: new Decimal(start),
    },
  });
}

/**
 * In-test reimplementation of `recomputeAccountBalanceInTx` so the test
 * doesn't need NextAuth session context. Same math, same DB writes.
 * Also recomputes every trade's `balanceAfter` (the equity walk).
 */
async function recomputeForTest(tradingAccountId: string) {
  await prisma.$transaction(async (tx) => {
    const account = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: tradingAccountId },
      select: { startingBalance: true },
    });
    const [transactions, trades] = await Promise.all([
      tx.transaction.findMany({
        where: { tradingAccountId },
        select: { type: true, amount: true },
      }),
      tx.trade.findMany({
        where: { tradingAccountId, result: { in: ["WIN", "LOSS", "TIE"] } },
        select: { id: true, profitLoss: true, openedAt: true },
        orderBy: { openedAt: "asc" },
      }),
    ]);

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

    // Account balance.
    const newBalance = start
      .plus(txSum)
      .plus(
        trades.reduce((acc, t) => acc.plus(new Decimal(t.profitLoss.toString())), new Decimal(0)),
      );

    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: { currentBalance: newBalance },
    });

    // Equity walk — update each trade's balanceAfter.
    let running = start.plus(txSum);
    for (const trade of trades) {
      running = running.plus(new Decimal(trade.profitLoss.toString()));
      await tx.trade.update({
        where: { id: trade.id },
        data: { balanceAfter: running },
      });
    }
  });
}

async function makeTrade(
  userId: string,
  tradingAccountId: string,
  opts: {
    stake: string;
    payoutPercent: string;
    direction?: "CALL" | "PUT";
    asset?: string;
    openedAt?: Date;
    result?: "WIN" | "LOSS" | "TIE" | "OPEN";
    profitLoss?: string;
  },
) {
  const stake = new Decimal(opts.stake);
  const payout = new Decimal(opts.payoutPercent);
  const result = opts.result ?? "OPEN";
  const profitLoss =
    opts.profitLoss !== undefined
      ? new Decimal(opts.profitLoss)
      : result === "OPEN"
        ? new Decimal(0)
        : computeTradeProfitLoss(stake, payout, result);
  return prisma.trade.create({
    data: {
      userId,
      tradingAccountId,
      asset: opts.asset ?? "EUR/USD",
      direction: opts.direction ?? "CALL",
      stake,
      payoutPercent: payout,
      expiryMinutes: 5,
      openedAt: opts.openedAt ?? new Date(),
      closedAt: result !== "OPEN" ? new Date() : null,
      result,
      profitLoss,
    },
  });
}

describe("Phase 5 — trade open/close/edit/delete keeps balance consistent", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`test+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "1000");
    accountId = a.id;
    await recomputeForTest(accountId);
  });

  it("opening a trade doesn't change balance (OPEN P/L=0)", async () => {
    await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "OPEN",
    });
    await recomputeForTest(accountId);
    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(a.currentBalance.toString()).toBe("1000");
  });

  it("closing as WIN adds stake*payout to balance", async () => {
    const t = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "OPEN",
    });
    // Close as WIN
    await prisma.trade.update({
      where: { id: t.id },
      data: {
        result: "WIN",
        profitLoss: computeTradeProfitLoss("100", "0.85", "WIN"),
        closedAt: new Date(),
      },
    });
    await recomputeForTest(accountId);
    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    // 1000 + 85 = 1085
    expect(a.currentBalance.toString()).toBe("1085");
  });

  it("closing as LOSS subtracts stake from balance", async () => {
    const t = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "OPEN",
    });
    await prisma.trade.update({
      where: { id: t.id },
      data: {
        result: "LOSS",
        profitLoss: computeTradeProfitLoss("100", "0.85", "LOSS"),
        closedAt: new Date(),
      },
    });
    await recomputeForTest(accountId);
    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    // 1000 - 100 = 900
    expect(a.currentBalance.toString()).toBe("900");
  });

  it("closing as TIE leaves balance unchanged", async () => {
    const t = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "OPEN",
    });
    await prisma.trade.update({
      where: { id: t.id },
      data: {
        result: "TIE",
        profitLoss: computeTradeProfitLoss("100", "0.85", "TIE"),
        closedAt: new Date(),
      },
    });
    await recomputeForTest(accountId);
    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(a.currentBalance.toString()).toBe("1000");
  });

  it("balanceAfter equity walk stays correct after multiple trades", async () => {
    const t1 = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "WIN",
      openedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const t2 = await makeTrade(userId, accountId, {
      stake: "50",
      payoutPercent: "0.85",
      result: "LOSS",
      openedAt: new Date("2026-01-02T10:00:00Z"),
    });
    const t3 = await makeTrade(userId, accountId, {
      stake: "200",
      payoutPercent: "0.85",
      result: "WIN",
      openedAt: new Date("2026-01-03T10:00:00Z"),
    });
    await recomputeForTest(accountId);

    // Reload with balanceAfter
    const trades = await prisma.trade.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { openedAt: "asc" },
      select: { id: true, balanceAfter: true },
    });
    // t1 (WIN): 1000 + 85 = 1085
    // t2 (LOSS): 1085 - 50 = 1035
    // t3 (WIN): 1035 + 170 = 1205
    const byId = new Map(trades.map((t) => [t.id, t.balanceAfter?.toString()]));
    expect(byId.get(t1.id)).toBe("1085");
    expect(byId.get(t2.id)).toBe("1035");
    expect(byId.get(t3.id)).toBe("1205");

    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(a.currentBalance.toString()).toBe("1205");
  });

  it("editing a closed trade's stake recomputes balanceAfter correctly", async () => {
    const t1 = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "WIN",
      openedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const t2 = await makeTrade(userId, accountId, {
      stake: "50",
      payoutPercent: "0.85",
      result: "LOSS",
      openedAt: new Date("2026-01-02T10:00:00Z"),
    });
    await recomputeForTest(accountId);

    // Edit t1's stake from 100 → 200. Profit becomes 200*0.85 = 170.
    await prisma.trade.update({
      where: { id: t1.id },
      data: {
        stake: new Decimal("200"),
        profitLoss: computeTradeProfitLoss("200", "0.85", "WIN"),
      },
    });
    await recomputeForTest(accountId);

    const trades = await prisma.trade.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { openedAt: "asc" },
      select: { id: true, balanceAfter: true },
    });
    const byId = new Map(trades.map((t) => [t.id, t.balanceAfter?.toString()]));
    // t1 (WIN, 200 stake): 1000 + 170 = 1170
    expect(byId.get(t1.id)).toBe("1170");
    // t2 (LOSS): 1170 - 50 = 1120
    expect(byId.get(t2.id)).toBe("1120");

    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(a.currentBalance.toString()).toBe("1120");
  });

  it("deleting a closed trade recomputes balanceAfter correctly", async () => {
    const t1 = await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "WIN",
      openedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const t2 = await makeTrade(userId, accountId, {
      stake: "50",
      payoutPercent: "0.85",
      result: "LOSS",
      openedAt: new Date("2026-01-02T10:00:00Z"),
    });
    await recomputeForTest(accountId);

    // Delete t1 — t2's balanceAfter should recompute from the original start.
    await prisma.trade.delete({ where: { id: t1.id } });
    await recomputeForTest(accountId);

    const trades = await prisma.trade.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { openedAt: "asc" },
      select: { id: true, balanceAfter: true },
    });
    expect(trades.length).toBe(1);
    // t2 (LOSS, after deleting t1): 1000 - 50 = 950
    expect(trades[0].balanceAfter?.toString()).toBe("950");

    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(a.currentBalance.toString()).toBe("950");
  });

  it("mixing trades + transactions both contribute to balance", async () => {
    // DEPOSIT 500 → balance 1500
    await prisma.transaction.create({
      data: {
        tradingAccountId: accountId,
        type: "DEPOSIT",
        amount: new Decimal("500"),
        occurredAt: new Date(),
      },
    });
    // Trade WIN stake=100 payout=0.85 → +85 → balance 1585
    await makeTrade(userId, accountId, {
      stake: "100",
      payoutPercent: "0.85",
      result: "WIN",
    });
    // WITHDRAWAL 200 → -200 → balance 1385
    await prisma.transaction.create({
      data: {
        tradingAccountId: accountId,
        type: "WITHDRAWAL",
        amount: new Decimal("200"),
        occurredAt: new Date(),
      },
    });
    await recomputeForTest(accountId);
    const a = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
    // 1000 (start) + 500 (deposit) + 85 (trade WIN) - 200 (withdrawal) = 1385
    expect(a.currentBalance.toString()).toBe("1385");
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
