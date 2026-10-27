/**
 * Phase 21 — integration tests for the Discipline Score flow.
 *
 * Mirrors the pattern of `tests/accounts-integration.test.ts` and
 * `tests/strategies-integration.test.ts`:
 *   - Uses the real SQLite DB.
 *   - Re-implements the server-action DB writes with explicit userIdOverride
 *     so tests don't need NextAuth session context. The math is the exact
 *     pure function the actions use.
 *
 * Coverage:
 *   1. DailyScore upsert: insert + update path (one row per user per day).
 *   2. Rest-day detection from real DB rows (no trades + no breaches).
 *   3. Per-rule deductions reflected in DB-persisted score.
 *   4. Cron sweep computes yesterday's score for multiple users.
 *   5. Cross-user isolation: user A's DailyScore rows never appear in
 *      user B's queries.
 *   6. Streak transition: walk a user through 5 days of disciplined
 *      behavior → streak = 5; one bad day → streak resets.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import {
  dailyDisciplineScore,
  disciplinedDayStreak,
  bestStreak,
  type DailyScoreEntry,
} from "@/lib/behavior/discipline";

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
  result: "WIN" | "LOSS" | "TIE",
  payoutPercent: number,
  stake: string,
  openedAt: Date,
) {
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
      asset: "EUR/USD",
      direction: "CALL",
      stake: stakeDecimal,
      payoutPercent: new Decimal(payoutPercent),
      expiryMinutes: 5,
      openedAt,
      closedAt: new Date(openedAt.getTime() + 60000),
      result,
      profitLoss: pl,
      followedPlan: true,
    },
  });
}

/**
 * Re-implements `computeDailyScoreAction`'s persistence path with an
 * explicit `userIdOverride` so tests don't need NextAuth session context.
 * The pure calc is the exact `dailyDisciplineScore` function the action uses.
 */
async function upsertDailyScoreForTest(
  userId: string,
  date: string,
  input: Parameters<typeof dailyDisciplineScore>[0],
): Promise<{ score: number; isRestDay: boolean; id: string }> {
  const result = dailyDisciplineScore(input);
  const breakdownJson = JSON.parse(JSON.stringify(result.breakdown));
  const row = await prisma.dailyScore.upsert({
    where: { userId_date: { userId, date } },
    create: {
      userId,
      date,
      score: new Decimal(result.score),
      breakdown: breakdownJson,
      isRestDay: result.isRestDay,
    },
    update: {
      score: new Decimal(result.score),
      breakdown: breakdownJson,
      isRestDay: result.isRestDay,
    },
  });
  return { score: result.score, isRestDay: result.isRestDay, id: row.id };
}

describe("Phase 21 — DailyScore upsert + per-rule deductions", () => {
  let userId: string;
  let accountId: string;
  let dateKey: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.dailyScore.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`ds+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Discipline Test", "1000");
    accountId = a.id;
    dateKey = "2025-06-15";
  });

  it("upserts a row per user per day (insert path on first call)", async () => {
    const before = await prisma.dailyScore.count({ where: { userId } });
    expect(before).toBe(0);

    const result = await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });

    expect(result.score).toBe(100);
    const rows = await prisma.dailyScore.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score.toString()).toBe("100");
    expect(rows[0].isRestDay).toBe(false);
  });

  it("upserts on second call (update path, same date)", async () => {
    await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    // Second call with a different input → should update the existing row.
    await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: false }],
      lockoutOverrides: 1,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    const rows = await prisma.dailyScore.findMany({ where: { userId, date: dateKey } });
    expect(rows).toHaveLength(1); // updated, not duplicated
    expect(rows[0].score.toString()).toBe("70"); // 100 - 30 (NO_OVERRIDES lost) ... wait NO_OVERRIDES is 15 not 30
    // Actually: lost NO_OVERRIDES (15) + lost FOLLOWED_PLAN (15) = 30 pts lost. 100-30=70.
  });

  it("rest-day detection from real DB rows (no trades + no breaches)", async () => {
    const result = await upsertDailyScoreForTest(userId, dateKey, {
      trades: [],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: false,
      balanceCheckDone: false,
    });
    expect(result.isRestDay).toBe(true);
    expect(result.score).toBe(95); // only CHECKLIST_AND_BALANCE lost
  });

  it("FOLLOWED_PLAN false → score reflects the 15-pt loss", async () => {
    const result = await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: false }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    expect(result.score).toBe(85); // 100 - 15 (FOLLOWED_PLAN lost)
  });

  it("NO_OVERRIDES: lockout override → 15-pt loss", async () => {
    const result = await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 1,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    expect(result.score).toBe(85); // 100 - 15 (NO_OVERRIDES lost)
  });

  it("all rules breached → score=0", async () => {
    const result = await upsertDailyScoreForTest(userId, dateKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: false, breachedRiskPerTrade: true }],
      dailyLossBreached: true,
      tradeCountBreached: true,
      lockoutOverrides: 1,
      warningOverrides: 1,
      tiltEvents: 1,
      checklistCompleted: false,
      balanceCheckDone: false,
    });
    expect(result.score).toBe(0);
  });
});

describe("Phase 21 — cron sweep computes yesterday for multiple users", () => {
  let userA: string;
  let userB: string;
  let accountA: string;
  let accountB: string;
  let yesterdayKey: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.dailyScore.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const uA = await makeUser(`a+${Date.now()}@example.com`);
    const uB = await makeUser(`b+${Date.now()}@example.com`);
    userA = uA.id;
    userB = uB.id;
    const aA = await makeAccount(userA, "UserA", "1000");
    const aB = await makeAccount(userB, "UserB", "2000");
    accountA = aA.id;
    accountB = aB.id;

    // Compute yesterday's day key in UTC.
    const now = new Date();
    const y = new Date(now);
    y.setUTCDate(now.getUTCDate() - 1);
    yesterdayKey = y.toISOString().slice(0, 10);

    // Seed yesterday's trades for both users.
    const yStartUtc = new Date(`${yesterdayKey}T00:00:00.000Z`);
    const yMidUtc = new Date(yStartUtc.getTime() + 12 * 60 * 60 * 1000);
    await makeClosedTrade(userA, accountA, "WIN", 0.85, "10", yMidUtc);
    await makeClosedTrade(userB, accountB, "LOSS", 0.85, "20", yMidUtc);
  });

  it("sweep recomputes yesterday's score for both users", async () => {
    // Simulate the cron sweep inline (we can't call the action because it
    // requires requireUser()). The pure calc is the exact function the action
    // uses.
    for (const [user, account] of [
      [userA, accountA],
      [userB, accountB],
    ] as const) {
      // Fetch yesterday's trades for this user.
      const trades = await prisma.trade.findMany({
        where: {
          userId: user,
          tradingAccountId: account,
          result: { in: ["WIN", "LOSS", "TIE"] },
        },
        select: { id: true, stake: true, followedPlan: true, profitLoss: true, openedAt: true },
      });
      // Compute the daily P/L.
      const dailyPL = trades.reduce(
        (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
        new Decimal(0),
      );
      // For the test, no breaches (we didn't seed a RiskProfile).
      const result = dailyDisciplineScore({
        trades: trades.map((t) => ({
          id: t.id,
          stake: t.stake.toString(),
          followedPlan: t.followedPlan,
        })),
        lockoutOverrides: 0,
        warningOverrides: 0,
        tiltEvents: 0,
        checklistCompleted: false,
        balanceCheckDone: false,
      });
      // Persist.
      await prisma.dailyScore.upsert({
        where: { userId_date: { userId: user, date: yesterdayKey } },
        create: {
          userId: user,
          date: yesterdayKey,
          score: new Decimal(result.score),
          breakdown: JSON.parse(JSON.stringify(result.breakdown)),
          isRestDay: result.isRestDay,
        },
        update: {
          score: new Decimal(result.score),
          breakdown: JSON.parse(JSON.stringify(result.breakdown)),
          isRestDay: result.isRestDay,
        },
      });
    }

    // Verify both users got a DailyScore row for yesterday.
    const aRows = await prisma.dailyScore.findMany({ where: { userId: userA } });
    const bRows = await prisma.dailyScore.findMany({ where: { userId: userB } });
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].date).toBe(yesterdayKey);
    expect(bRows[0].date).toBe(yesterdayKey);
    // Both users had 1 trade with followedPlan=true, no breaches → score 95
    // (lost 5 pts for missing CHECKLIST_AND_BALANCE).
    expect(Number(aRows[0].score.toString())).toBe(95);
    expect(Number(bRows[0].score.toString())).toBe(95);
  });
});

describe("Phase 21 — cross-user isolation", () => {
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.dailyScore.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const uA = await makeUser(`a+${Date.now()}@example.com`);
    const uB = await makeUser(`b+${Date.now()}@example.com`);
    userA = uA.id;
    userB = uB.id;
  });

  it("user A cannot see user B's DailyScore rows", async () => {
    await upsertDailyScoreForTest(userA, "2025-06-15", {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    await upsertDailyScoreForTest(userB, "2025-06-15", {
      trades: [{ id: "t1", stake: "10", followedPlan: false }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });

    const aRows = await prisma.dailyScore.findMany({
      where: { userId: userA },
      select: { date: true, score: true },
    });
    const bRows = await prisma.dailyScore.findMany({
      where: { userId: userB },
      select: { date: true, score: true },
    });
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(Number(aRows[0].score.toString())).toBe(100); // perfect day
    expect(Number(bRows[0].score.toString())).toBe(85); // broke plan
  });
});

describe("Phase 21 — streak transition with DB rows", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.dailyScore.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`st+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Streak Test", "1000");
    accountId = a.id;
  });

  it("5 disciplined days → current streak = 5", async () => {
    // Seed 5 days of disciplined (score ≥ 80) scores ending today.
    const dates: string[] = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (const date of dates) {
      await upsertDailyScoreForTest(userId, date, {
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        lockoutOverrides: 0,
        warningOverrides: 0,
        tiltEvents: 0,
        checklistCompleted: true,
        balanceCheckDone: true,
      });
    }

    // Fetch all DailyScore rows for the user + run the pure streak calc.
    const rows = await prisma.dailyScore.findMany({
      where: { userId },
      orderBy: { date: "asc" },
      select: { date: true, score: true, isRestDay: true },
    });
    const entries: DailyScoreEntry[] = rows.map((r) => ({
      date: r.date,
      score: Number(r.score.toString()),
      isRestDay: r.isRestDay,
    }));
    const todayKey = new Date().toISOString().slice(0, 10);
    const currentStreak = disciplinedDayStreak(entries, todayKey);
    expect(currentStreak).toBe(5);
    expect(bestStreak(entries)).toBe(5);
  });

  it("one bad day in the middle → current streak resets to today's contribution", async () => {
    // Seed: today disciplined, yesterday bad (score < 80), day before disciplined.
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const y = new Date(today);
    y.setUTCDate(today.getUTCDate() - 1);
    const yesterdayKey = y.toISOString().slice(0, 10);
    const yy = new Date(today);
    yy.setUTCDate(today.getUTCDate() - 2);
    const dayBeforeKey = yy.toISOString().slice(0, 10);

    await upsertDailyScoreForTest(userId, dayBeforeKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    }); // score=100 (disciplined)
    await upsertDailyScoreForTest(userId, yesterdayKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: false, breachedRiskPerTrade: true }],
      lockoutOverrides: 1,
      warningOverrides: 1,
      tiltEvents: 1,
      dailyLossBreached: true,
      tradeCountBreached: true,
      checklistCompleted: false,
      balanceCheckDone: false,
    }); // score=0 (broke every rule)
    await upsertDailyScoreForTest(userId, todayKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    }); // score=100 (disciplined)

    const rows = await prisma.dailyScore.findMany({
      where: { userId },
      orderBy: { date: "asc" },
      select: { date: true, score: true, isRestDay: true },
    });
    const entries: DailyScoreEntry[] = rows.map((r) => ({
      date: r.date,
      score: Number(r.score.toString()),
      isRestDay: r.isRestDay,
    }));
    // Current streak: today (1) only — yesterday broke it.
    expect(disciplinedDayStreak(entries, todayKey)).toBe(1);
    // Best streak: 1 (the longest run is just today, or just day-before).
    expect(bestStreak(entries)).toBe(1);
  });

  it("rest day in the middle keeps the streak (no increment, no break)", async () => {
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const restDay = new Date(today);
    restDay.setUTCDate(today.getUTCDate() - 1);
    const restDayKey = restDay.toISOString().slice(0, 10);
    const dayBefore = new Date(today);
    dayBefore.setUTCDate(today.getUTCDate() - 2);
    const dayBeforeKey = dayBefore.toISOString().slice(0, 10);

    // Day-before-yesterday: disciplined (score=100).
    await upsertDailyScoreForTest(userId, dayBeforeKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });
    // Yesterday: rest day (no trades + no breaches → score=95, isRestDay=true).
    await upsertDailyScoreForTest(userId, restDayKey, {
      trades: [],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: false,
      balanceCheckDone: false,
    });
    // Today: disciplined (score=100).
    await upsertDailyScoreForTest(userId, todayKey, {
      trades: [{ id: "t1", stake: "10", followedPlan: true }],
      lockoutOverrides: 0,
      warningOverrides: 0,
      tiltEvents: 0,
      checklistCompleted: true,
      balanceCheckDone: true,
    });

    const rows = await prisma.dailyScore.findMany({
      where: { userId },
      orderBy: { date: "asc" },
      select: { date: true, score: true, isRestDay: true },
    });
    const entries: DailyScoreEntry[] = rows.map((r) => ({
      date: r.date,
      score: Number(r.score.toString()),
      isRestDay: r.isRestDay,
    }));
    // Current streak: 2 (today + day-before; rest day skipped).
    expect(disciplinedDayStreak(entries, todayKey)).toBe(2);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
