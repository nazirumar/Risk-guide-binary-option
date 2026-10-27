/**
 * Phase 7 — integration tests for `evaluateRisk()`. Uses the real SQLite
 * DB. Each test sets up a user + account + risk profile + trades + optional
 * lockout, then asserts the verdict + reasons match the spec.
 *
 * Tests cover all 8 rules from the spec:
 *   1. Active lockout → BLOCK
 *   2. Daily loss reached → BLOCK
 *   3. Weekly loss reached → BLOCK
 *   4. Daily profit target reached → BLOCK (stop-when-ahead)
 *   5. Max consecutive losses → BLOCK
 *   6. Max trades per day → BLOCK
 *   7. Too many open trades → BLOCK
 *   8. Stake > risk-per-trade limit → WARN
 *
 * Plus timezone edge cases (UTC vs Africa/Lagos vs Pacific/Honolulu).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import Decimal from "decimal.js";

import { evaluateRisk } from "@/server/lib/risk-check";

const prisma = new PrismaClient();

async function makeUser(email: string, timezone = "UTC") {
  return prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await argon2.hash("test-pass"),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone,
    },
  });
}

async function makeAccount(userId: string, balance: string) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      name: "Test",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal(balance),
      currentBalance: new Decimal(balance),
    },
  });
}

async function makeProfile(
  userId: string,
  tradingAccountId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.riskProfile.create({
    data: {
      userId,
      tradingAccountId,
      riskPerTradePercent: new Decimal(2),
      maxDailyLossPercent: new Decimal(6),
      maxDailyLossAmount: null,
      dailyProfitTargetPercent: null,
      maxTradesPerDay: 10,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 15,
      maxOpenTrades: 3,
      weeklyLossLimitPercent: null,
      lockoutEnabled: true,
      ...overrides,
    } as never,
  });
}

async function makeTrade(
  userId: string,
  tradingAccountId: string,
  opts: {
    stake?: string;
    payoutPercent?: string;
    direction?: "CALL" | "PUT";
    result?: "WIN" | "LOSS" | "TIE" | "OPEN";
    profitLoss?: string;
    openedAt?: Date;
    closedAt?: Date;
  },
) {
  const stake = new Decimal(opts.stake ?? "100");
  const payout = new Decimal(opts.payoutPercent ?? "0.85");
  const result = opts.result ?? "OPEN";
  const profitLoss =
    opts.profitLoss !== undefined
      ? new Decimal(opts.profitLoss)
      : result === "OPEN"
        ? new Decimal(0)
        : result === "WIN"
          ? stake.mul(payout)
          : result === "LOSS"
            ? stake.neg()
            : new Decimal(0);
  return prisma.trade.create({
    data: {
      userId,
      tradingAccountId,
      asset: "EUR/USD",
      direction: opts.direction ?? "CALL",
      stake,
      payoutPercent: payout,
      expiryMinutes: 5,
      openedAt: opts.openedAt ?? new Date(),
      closedAt: opts.closedAt ?? (result !== "OPEN" ? new Date() : null),
      result,
      profitLoss,
    },
  });
}

describe("Phase 7 — evaluateRisk rules", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.lockout.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`test+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "1000");
    accountId = a.id;
    await makeProfile(userId, accountId);
  });

  // ─── Rule 0: No trades, no breach → OK ─────────────────────────────────

  it("returns OK when no rules are breached", async () => {
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.allowed).toBe(true);
    expect(res.severity).toBe("OK");
    expect(res.reasons).toEqual([]);
  });

  // ─── Rule 1: Active lockout → BLOCK ────────────────────────────────────

  it("Rule 1 — active lockout → BLOCK", async () => {
    await prisma.lockout.create({
      data: {
        userId,
        reason: "MANUAL",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.allowed).toBe(false);
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Active lockout"))).toBe(true);
  });

  it("Rule 1 — expired lockout doesn't block", async () => {
    await prisma.lockout.create({
      data: {
        userId,
        reason: "MANUAL",
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000), // expired 1h ago
      },
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.allowed).toBe(true);
    expect(res.severity).toBe("OK");
  });

  it("Rule 1 — overridden lockout doesn't block", async () => {
    await prisma.lockout.create({
      data: {
        userId,
        reason: "MANUAL",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        overriddenAt: new Date(),
        overrideReason: "Test override",
      },
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.allowed).toBe(true);
  });

  // ─── Rule 2: Daily loss reached → BLOCK ───────────────────────────────

  it("Rule 2 — daily loss % reached → BLOCK", async () => {
    // Balance 1000, maxDailyLossPercent 6% = $60 loss cap.
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss limit reached"))).toBe(true);
  });

  it("Rule 2 — daily loss below threshold → OK", async () => {
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "50",
      profitLoss: "-50",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("OK");
  });

  it("Rule 2 — daily loss amount cap reached → BLOCK", async () => {
    await prisma.riskProfile.updateMany({
      where: { userId, tradingAccountId: accountId },
      data: { maxDailyLossAmount: new Decimal(30) },
    });
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "30",
      profitLoss: "-30",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss amount limit"))).toBe(true);
  });

  // ─── Rule 3: Weekly loss reached → BLOCK ──────────────────────────────

  it("Rule 3 — weekly loss reached → BLOCK", async () => {
    await prisma.riskProfile.updateMany({
      where: { userId, tradingAccountId: accountId },
      data: { weeklyLossLimitPercent: new Decimal(12) },
    });
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "120",
      profitLoss: "-120",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Weekly loss limit"))).toBe(true);
  });

  // ─── Rule 4: Daily profit target → BLOCK (stop-when-ahead) ────────────

  it("Rule 4 — daily profit target reached → BLOCK (stop-when-ahead)", async () => {
    await prisma.riskProfile.updateMany({
      where: { userId, tradingAccountId: accountId },
      data: { dailyProfitTargetPercent: new Decimal(4) },
    });
    await makeTrade(userId, accountId, {
      result: "WIN",
      stake: "50",
      profitLoss: "40",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily profit target reached"))).toBe(true);
  });

  // ─── Rule 5: Max consecutive losses → BLOCK ──────────────────────────

  it("Rule 5 — 3 consecutive losses → BLOCK", async () => {
    const now = new Date();
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "10",
      profitLoss: "-10",
      openedAt: now,
      closedAt: now,
    });
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "10",
      profitLoss: "-10",
      openedAt: now,
      closedAt: now,
    });
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "10",
      profitLoss: "-10",
      openedAt: now,
      closedAt: now,
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Max consecutive losses reached"))).toBe(true);
  });

  it("Rule 5 — 2 consecutive losses then a WIN → OK (streak reset)", async () => {
    const now = new Date();
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "10",
      profitLoss: "-10",
      openedAt: now,
      closedAt: now,
    });
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "10",
      profitLoss: "-10",
      openedAt: now,
      closedAt: now,
    });
    await makeTrade(userId, accountId, {
      result: "WIN",
      stake: "10",
      profitLoss: "8.5",
      openedAt: now,
      closedAt: now,
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("OK");
  });

  // ─── Rule 6: Max trades per day → BLOCK ────────────────────────────────

  it("Rule 6 — max trades per day reached → BLOCK", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await makeTrade(userId, accountId, {
        result: "WIN",
        stake: "10",
        profitLoss: "8.5",
        openedAt: now,
        closedAt: now,
      });
    }
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Max trades per day reached"))).toBe(true);
  });

  // ─── Rule 7: Too many open trades → BLOCK ─────────────────────────────

  it("Rule 7 — too many open trades → BLOCK", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await makeTrade(userId, accountId, {
        result: "OPEN",
        stake: "10",
        openedAt: now,
      });
    }
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Too many open trades"))).toBe(true);
  });

  // ─── Rule 8: Stake > risk-per-trade limit → WARN ────────────────────────

  it("Rule 8 — stake > risk-per-trade limit → WARN (not BLOCK)", async () => {
    // Balance $1000, riskPerTradePercent 2% = $20 cap. Try $50 stake.
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 50 });
    expect(res.allowed).toBe(true);
    expect(res.severity).toBe("WARN");
    expect(res.reasons.some((r) => r.includes("risk-per-trade"))).toBe(true);
  });

  it("Rule 8 — stake under limit → OK", async () => {
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 20 });
    expect(res.severity).toBe("OK");
    expect(res.reasons).toEqual([]);
  });

  // ─── Priority: BLOCK rules beat WARN ──────────────────────────────────

  it("Priority — BLOCK + WARN together → BLOCK wins", async () => {
    // Set up daily loss breach + try a stake that exceeds risk-per-trade.
    await makeTrade(userId, accountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date(),
    });
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 50 });
    expect(res.allowed).toBe(false);
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
    // The WARN reason (Rule 8) only fires when severity != BLOCK — so it
    // shouldn't be in the reasons list.
    expect(res.reasons.some((r) => r.includes("risk-per-trade"))).toBe(false);
  });

  // ─── Context payload ──────────────────────────────────────────────────

  it("returns context with dailyPL, tradesToday, openTrades, currentLossStreak, balance, riskPerTradeLimit", async () => {
    const res = await evaluateRisk({ userId, tradingAccountId: accountId, stake: 50 });
    expect(res.context).toBeDefined();
    expect(res.context?.dailyPL).toBe("0");
    expect(res.context?.weeklyPL).toBe("0");
    expect(res.context?.tradesToday).toBe(0);
    expect(res.context?.openTrades).toBe(0);
    expect(res.context?.currentLossStreak).toBe(0);
    expect(res.context?.balance).toBe("1000");
    expect(res.context?.riskPerTradeLimit).toBe("20"); // 2% of 1000
  });
});

// ─── Timezone edge cases ─────────────────────────────────────────────────

describe("Phase 7 — evaluateRisk timezone edge cases", () => {
  let tzUserId: string;
  let tzAccountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.lockout.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();
  });

  it("user in UTC+1 (Lagos) — yesterday-UTC trade counts as today-Lagos trade", async () => {
    // Lagos is UTC+1. Lagos midnight on 2026-10-26 = 2026-10-25 23:00 UTC.
    // A trade at 2026-10-25 23:30 UTC = 2026-10-26 00:30 Lagos → today in Lagos.
    const u = await makeUser(`lagos+${Date.now()}@example.com`, "Africa/Lagos");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    // Place a $60 LOSS trade at 2026-10-25 23:30 UTC — which is Lagos's "today".
    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date("2026-10-25T23:30:00Z"),
      closedAt: new Date("2026-10-25T23:35:00Z"),
    });

    // Check risk at 2026-10-26 11:00 UTC = 2026-10-26 12:00 Lagos (still today).
    // Pass `now` so the test is deterministic (doesn't depend on test-run date).
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-10-26T11:00:00Z") },
    );
    // The 23:30 UTC trade falls within Lagos's "today" (2026-10-26).
    // 6% of $1000 = $60 cap → BLOCK.
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
  });

  it("user in UTC-10 (Honolulu) — UTC today's trade counts as TZ today's trade", async () => {
    // Honolulu is UTC-10. Honolulu midnight on 2026-10-26 = 2026-10-26 10:00 UTC.
    // A trade at 2026-10-26 11:00 UTC = 2026-10-26 01:00 Honolulu → today in Honolulu.
    const u = await makeUser(`hawaii+${Date.now()}@example.com`, "Pacific/Honolulu");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date("2026-10-26T11:00:00Z"),
      closedAt: new Date("2026-10-26T11:05:00Z"),
    });

    // Check at 2026-10-26 20:00 UTC = 2026-10-26 10:00 Honolulu — still today.
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-10-26T20:00:00Z") },
    );
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
  });

  it("user in UTC+14 (Kiritimati) — extreme east edge", async () => {
    // Kiritimati is UTC+14. Kiritimati midnight on 2026-10-26 = 2026-10-25 10:00 UTC.
    // A trade at 2026-10-25 11:00 UTC = 2026-10-26 01:00 Kiritimati → today in Kiritimati.
    const u = await makeUser(`kiri+${Date.now()}@example.com`, "Pacific/Kiritimati");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date("2026-10-25T11:00:00Z"),
      closedAt: new Date("2026-10-25T11:05:00Z"),
    });

    // Check at 2026-10-25 20:00 UTC = 2026-10-26 10:00 Kiritimati — still today.
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-10-25T20:00:00Z") },
    );
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
  });

  it("user in UTC+12 (Auckland) — DST handling (NZ summer = UTC+13)", async () => {
    // Auckland observes DST. In summer (Jan), it's UTC+13; in winter (Jul), UTC+12.
    // Pick a summer date: 2026-01-15. Auckland midnight = 2026-01-14 11:00 UTC.
    const u = await makeUser(`akl+${Date.now()}@example.com`, "Pacific/Auckland");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    // Trade at 2026-01-14 12:00 UTC = 2026-01-15 01:00 Auckland (summer UTC+13).
    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date("2026-01-14T12:00:00Z"),
      closedAt: new Date("2026-01-14T12:05:00Z"),
    });

    // Evaluate at 2026-01-14 23:00 UTC = 2026-01-15 12:00 Auckland — still today.
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-01-14T23:00:00Z") },
    );
    // Should be BLOCK (today's loss hit the $60 cap).
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
  });

  it("user in UTC+12 (Auckland) — winter (no DST, UTC+12)", async () => {
    // Pick a winter date: 2026-07-15. Auckland midnight = 2026-07-14 12:00 UTC.
    const u = await makeUser(`aklw+${Date.now()}@example.com`, "Pacific/Auckland");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    // Trade at 2026-07-14 13:00 UTC = 2026-07-15 01:00 Auckland (winter UTC+12).
    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "60",
      profitLoss: "-60",
      openedAt: new Date("2026-07-14T13:00:00Z"),
      closedAt: new Date("2026-07-14T13:05:00Z"),
    });

    // Evaluate at 2026-07-14 23:00 UTC = 2026-07-15 11:00 Auckland — still today.
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-07-14T23:00:00Z") },
    );
    expect(res.severity).toBe("BLOCK");
    expect(res.reasons.some((r) => r.includes("Daily loss"))).toBe(true);
  });

  it("midnight rollover in user TZ — yesterday's loss no longer counts", async () => {
    // User in UTC. Place a $200 LOSS yesterday (2026-10-25 12:00 UTC).
    // Evaluate today (2026-10-26 12:00 UTC). Yesterday's loss should NOT count.
    const u = await makeUser(`rollover+${Date.now()}@example.com`, "UTC");
    tzUserId = u.id;
    const a = await makeAccount(tzUserId, "1000");
    tzAccountId = a.id;
    await makeProfile(tzUserId, tzAccountId);

    await makeTrade(tzUserId, tzAccountId, {
      result: "LOSS",
      stake: "200",
      profitLoss: "-200",
      openedAt: new Date("2026-10-25T12:00:00Z"),
      closedAt: new Date("2026-10-25T12:05:00Z"),
    });

    // Evaluate today at noon UTC.
    const res = await evaluateRisk(
      { userId: tzUserId, tradingAccountId: tzAccountId, stake: 20 },
      { now: new Date("2026-10-26T12:00:00Z") },
    );
    // Yesterday's $200 loss doesn't count toward today's $60 cap.
    expect(res.severity).toBe("OK");
    expect(res.reasons).toEqual([]);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
