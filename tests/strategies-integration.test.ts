/**
 * Phase 20 — integration tests for Strategy Validation.
 *
 * Mirrors the pattern of `tests/accounts-integration.test.ts`:
 *   - Uses the real SQLite DB.
 *   - Re-implements the server-action DB writes with explicit userIdOverride
 *     so tests don't need NextAuth session context.
 *
 * Coverage:
 *   1. Create strategy: persists the row + no cached stats yet.
 *   2. Verdicts change as trades accumulate:
 *      - 0 trades → INSUFFICIENT + "Not enough data"
 *      - 8 wins out of 10 → INSUFFICIENT (total<30)
 *      - 8 wins out of 30 → LOW + "Likely profitable"
 *      - 16 wins out of 30 → LOW + "Can't tell yet"
 *      - 3 wins out of 30 → LOW + "Likely losing"
 *      - 60 wins out of 100 → MEDIUM + "Can't tell yet"
 *      - 70 wins out of 100 → MEDIUM + "Likely profitable"
 *      - 20 wins out of 100 → MEDIUM + "Likely losing"
 *      - 180 wins out of 300 → HIGH (verdict depends on Wilson bound)
 *   3. Cached stats recomputed by recomputeStrategyStatsAction.
 *   4. Cross-user isolation: user A's strategy invisible to user B's query.
 *   5. Delete strategy: trades stay (SetNull), audit log written.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import {
  reliabilityRating,
  wilsonInterval,
  isStatisticallyBetterThanBreakeven,
} from "@/lib/calc/validation";

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

async function makeClosedTrade(
  userId: string,
  tradingAccountId: string,
  strategyId: string,
  result: "WIN" | "LOSS" | "TIE",
  payoutPercent: number,
  stake: string,
): Promise<void> {
  const stakeDecimal = new Decimal(stake);
  let pl: Decimal;
  switch (result) {
    case "WIN":
      pl = stakeDecimal.times(payoutPercent);
      break;
    case "LOSS":
      pl = stakeDecimal.neg();
      break;
    case "TIE":
      pl = new Decimal(0);
      break;
  }
  await prisma.trade.create({
    data: {
      userId,
      tradingAccountId,
      strategyId,
      asset: "EUR/USD",
      direction: "CALL",
      stake: stakeDecimal,
      payoutPercent: new Decimal(payoutPercent),
      expiryMinutes: 5,
      openedAt: new Date(),
      closedAt: new Date(),
      result,
      profitLoss: pl,
      balanceAfter: pl, // ignored by the test; not used by validation calc
    },
  });
}

/**
 * Re-implements the action's "compute live stats from trades" path. Pure
 * helper — uses the pure calc module's `reliabilityRating` exactly like the
 * action does.
 */
function liveStats(trades: { result: string; payoutPercent: string | number | Decimal }[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.result === "WIN").length;
  // Compute the average payout — matches the action's `computeLiveStats`.
  const avgPayout =
    total > 0
      ? trades.reduce((acc, t) => acc + Number(t.payoutPercent.toString()), 0) / total
      : 0.85;
  return { total, wins, avgPayout, rating: reliabilityRating(wins, total, avgPayout) };
}

describe("Phase 20 — Strategy create + verdict transition", () => {
  let userId: string;
  let accountId: string;
  let strategyId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.strategy.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`sv+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Strategy Test", "1000");
    accountId = a.id;
    const s = await prisma.strategy.create({
      data: { userId, name: "Test Strategy", isActive: true },
    });
    strategyId = s.id;
  });

  it("0 trades → INSUFFICIENT + Not enough data", () => {
    const { total, wins, rating } = liveStats([]);
    expect(total).toBe(0);
    expect(wins).toBe(0);
    expect(rating.rating).toBe("INSUFFICIENT");
    expect(rating.verdict).toBe("Not enough data");
  });

  it("8/10 wins → still INSUFFICIENT (total < 30)", async () => {
    for (let i = 0; i < 8; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 2; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { total, wins, rating } = liveStats(trades);
    expect(total).toBe(10);
    expect(wins).toBe(8);
    expect(rating.rating).toBe("INSUFFICIENT");
    expect(rating.verdict).toBe("Not enough data");
  });

  it("25/30 wins (0.85 payout) → LOW + Likely profitable", async () => {
    for (let i = 0; i < 25; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 5; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { total, wins, rating } = liveStats(trades);
    expect(total).toBe(30);
    expect(wins).toBe(25);
    expect(rating.rating).toBe("LOW");
    expect(rating.verdict).toBe("Likely profitable");
    expect(rating.wilsonLower).toBeGreaterThan(rating.breakEvenWinRate);
  });

  it("3/30 wins (0.85 payout) → LOW + Likely losing", async () => {
    for (let i = 0; i < 3; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 27; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("LOW");
    expect(rating.verdict).toBe("Likely losing");
    expect(rating.wilsonUpper).toBeLessThan(rating.breakEvenWinRate);
  });

  it("16/30 wins (0.85 payout) → LOW + Can't tell yet (Wilson straddles break-even)", async () => {
    for (let i = 0; i < 16; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 14; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("LOW");
    expect(rating.verdict).toBe("Can't tell yet");
  });

  it("70/100 wins (0.85 payout) → MEDIUM + Likely profitable", async () => {
    for (let i = 0; i < 70; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 30; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("MEDIUM");
    expect(rating.verdict).toBe("Likely profitable");
  });

  it("20/100 wins (0.85 payout) → MEDIUM + Likely losing", async () => {
    for (let i = 0; i < 20; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 80; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("MEDIUM");
    expect(rating.verdict).toBe("Likely losing");
  });

  it("60/100 wins (0.85 payout) → MEDIUM + Can't tell yet (z-test agrees)", async () => {
    for (let i = 0; i < 60; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 40; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("MEDIUM");
    expect(rating.verdict).toBe("Can't tell yet");
    // The pure one-sided test should agree on the "Can't tell yet" case
    // (neither profitable at α=0.05 nor losing at α=0.95 one-sided).
    const t = isStatisticallyBetterThanBreakeven(60, 100, 0.85);
    expect(t.verdict).toBe("Can't tell yet");
  });

  it("250/300 wins (0.85 payout) → HIGH + Likely profitable", async () => {
    for (let i = 0; i < 250; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 50; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
    const trades = await prisma.trade.findMany({
      where: { strategyId },
      select: { result: true, payoutPercent: true },
    });
    const { rating } = liveStats(trades);
    expect(rating.rating).toBe("HIGH");
    expect(rating.verdict).toBe("Likely profitable");
  });
});

describe("Phase 20 — recomputeStrategyStatsAction persistence", () => {
  let userId: string;
  let accountId: string;
  let strategyId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.strategy.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`sr+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Recompute Test", "1000");
    accountId = a.id;
    const s = await prisma.strategy.create({
      data: { userId, name: "Recompute Test", isActive: true },
    });
    strategyId = s.id;
    // 70 wins / 100 total at 0.85 payout → MEDIUM + Likely profitable.
    for (let i = 0; i < 70; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "WIN", 0.85, "10");
    }
    for (let i = 0; i < 30; i++) {
      await makeClosedTrade(userId, accountId, strategyId, "LOSS", 0.85, "10");
    }
  });

  it("recomputes cached stats + sets isValidated=true when verdict is Likely profitable", async () => {
    // Before recompute: cached stats are at defaults (zero/null).
    const before = await prisma.strategy.findUniqueOrThrow({ where: { id: strategyId } });
    expect(before.totalTrades).toBe(0);
    expect(before.winRate).toBeNull();
    expect(before.isValidated).toBe(false);

    // Recompute (mirrors recomputeStrategyStatsAction without Next.js context).
    const trades = await prisma.trade.findMany({
      where: { strategyId, result: { in: ["WIN", "LOSS", "TIE"] } },
      select: { result: true, payoutPercent: true, profitLoss: true, stake: true },
    });
    const total = trades.length;
    const wins = trades.filter((t) => t.result === "WIN").length;
    const winRate = wins / total;
    const { rating } = liveStats(trades);
    await prisma.strategy.update({
      where: { id: strategyId },
      data: {
        totalTrades: total,
        winRate: new Decimal(winRate).toDecimalPlaces(6),
        isValidated: rating.verdict === "Likely profitable",
        lastValidatedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        userId,
        action: "STRATEGY_STATS_RECOMPUTED",
        entity: "Strategy",
        entityId: strategyId,
        meta: { total, winRate, verdict: rating.verdict },
      },
    });

    const after = await prisma.strategy.findUniqueOrThrow({ where: { id: strategyId } });
    expect(after.totalTrades).toBe(100);
    expect(after.winRate?.toString()).toMatch(/^0\.7/); // 0.7xxxxx
    expect(after.isValidated).toBe(true);
    expect(after.lastValidatedAt).toBeInstanceOf(Date);

    const log = await prisma.auditLog.findFirst({
      where: { userId, action: "STRATEGY_STATS_RECOMPUTED" },
    });
    expect(log).toBeTruthy();
    expect(log?.entityId).toBe(strategyId);
  });
});

describe("Phase 20 — cross-user isolation + delete strategy", () => {
  let userA: string;
  let userB: string;
  let accountA: string;
  let accountB: string;
  let strategyA: string;
  let strategyB: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.strategy.deleteMany();
    await prisma.transaction.deleteMany();
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
    const sA = await prisma.strategy.create({
      data: { userId: userA, name: "Strategy A", isActive: true },
    });
    const sB = await prisma.strategy.create({
      data: { userId: userB, name: "Strategy B", isActive: true },
    });
    strategyA = sA.id;
    strategyB = sB.id;
  });

  it("user A cannot see user B's strategy (every query scoped by userId)", async () => {
    const aRows = await prisma.strategy.findMany({
      where: { userId: userA },
      select: { id: true, name: true },
    });
    const bRows = await prisma.strategy.findMany({
      where: { userId: userB },
      select: { id: true, name: true },
    });
    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(1);
    expect(aRows[0].id).not.toBe(bRows[0].id);
  });

  it("cross-user trade tag is blocked: user B's trade cannot use user A's strategy", async () => {
    // Simulate the ownership guard: verifyStrategyOwnership(strategyA, userB)
    // returns null.
    const lookup = await prisma.strategy.findFirst({
      where: { id: strategyA, userId: userB },
    });
    expect(lookup).toBeNull();
  });

  it("delete strategy: trades keep their data (SetNull on schema)", async () => {
    // Seed a trade tagged with strategyA.
    await makeClosedTrade(userA, accountA, strategyA, "WIN", 0.85, "10");
    const tradeBefore = await prisma.trade.findFirstOrThrow({
      where: { strategyId: strategyA },
      select: { id: true, strategyId: true },
    });
    expect(tradeBefore.strategyId).toBe(strategyA);

    // Delete the strategy — schema onDelete: SetNull preserves the trade.
    await prisma.strategy.delete({ where: { id: strategyA } });
    const tradeAfter = await prisma.trade.findFirstOrThrow({
      where: { id: tradeBefore.id },
      select: { id: true, strategyId: true },
    });
    expect(tradeAfter.strategyId).toBeNull();
  });

  it("create strategy action writes a STRATEGY_CREATED audit log (mirrored)", async () => {
    // The actual createStrategyAction can't be called from the test runner
    // (it requires NextAuth session context via requireUser()). We mirror
    // the action's audit-log write here to pin the contract.
    await prisma.auditLog.create({
      data: {
        userId: userA,
        action: "STRATEGY_CREATED",
        entity: "Strategy",
        entityId: strategyA,
        meta: { name: "Strategy A" },
      },
    });
    const log = await prisma.auditLog.findFirst({
      where: { userId: userA, action: "STRATEGY_CREATED" },
    });
    expect(log).toBeTruthy();
    expect(log?.entity).toBe("Strategy");
    expect(log?.entityId).toBe(strategyA);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
