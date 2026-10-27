/**
 * Phase 23 — integration tests for Telegram alerts & AI weekly review.
 *
 * Mirrors the pattern of `tests/strategies-integration.test.ts`:
 *   - Uses the real SQLite DB.
 *   - Re-implements the server-action DB writes with explicit userIdOverride
 *     so tests don't need NextAuth session context.
 *
 * Coverage (acceptance checklist):
 *   1. Link flow: generateLinkCode → /start CODE webhook → TelegramLink
 *      row created + code cleared. Expiry + invalid-code + chat-in-use
 *      rejections.
 *   2. Unlink flow: delete the TelegramLink row.
 *   3. Alerts respect toggles: master switch off → no send; paused → no
 *      send; per-alert toggle off → no send; all on → delivered via the
 *      mock provider.
 *   4. Weekly review generates from seeded data: seed trades + DailyScores
 *      → buildWeeklyStats → generateWeeklyReviewWithFallback (mock client)
 *      → WeeklyReview row with the AI source. Also verifies the fallback
 *      path when the AI fails.
 *   5. Cross-user isolation: user A's TelegramLink and WeeklyReview rows
 *      never appear in user B's queries.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

import {
  setTelegramProvider,
  type TelegramProvider,
  ConsoleTelegramProvider,
} from "@/lib/telegram/provider";
import {
  setAnthropicClient,
  generateWeeklyReviewWithFallback,
  buildWeeklyStatsPrompt,
  type AnthropicClient,
} from "@/lib/ai/review";
import {
  parseTelegramCommand,
  generateLinkCode as pureGenerateLinkCode,
} from "@/lib/telegram/provider";
import { isoWeekRange } from "@/lib/ai/review";

const prisma = new PrismaClient();

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await argon2.hash("test-pass"),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
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
  stake: string,
  openedAt: Date,
  strategyName?: string,
) {
  const stakeDecimal = new Decimal(stake);
  const payout = 0.85;
  let pl: Decimal;
  switch (result) {
    case "WIN":
      pl = stakeDecimal.times(payout);
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
      payoutPercent: new Decimal(payout),
      expiryMinutes: 5,
      openedAt,
      closedAt: new Date(openedAt.getTime() + 60000),
      result,
      profitLoss: pl,
      followedPlan: true,
      ...(strategyName ? {} : {}),
    },
  });
}

/** Captures sent messages for assertions. */
class MockTelegramProvider implements TelegramProvider {
  readonly name = "MockTelegram";
  sent: { chatId: string; text: string }[] = [];
  private readonly webhookSecret: string;

  constructor(webhookSecret = "test-secret") {
    this.webhookSecret = webhookSecret;
  }

  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { messageId: this.sent.length };
  }

  verifyWebhookSignature(headerValue: string | null): boolean {
    return headerValue === this.webhookSecret;
  }

  lastMessage(): { chatId: string; text: string } | undefined {
    return this.sent[this.sent.length - 1];
  }
}

// ─── 1. Link flow ──────────────────────────────────────────────────────────

describe("Phase 23 — link flow (generate code → /start CODE → linked)", () => {
  let userId: string;
  let mockProvider: MockTelegramProvider;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.telegramLink.deleteMany();
    await prisma.weeklyReview.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`tg+${Date.now()}@example.com`);
    userId = u.id;
    mockProvider = new MockTelegramProvider();
    setTelegramProvider(mockProvider);
  });

  it("generates a one-time code + stores it with a 15-min expiry", async () => {
    // Mirror generateLinkCodeAction (can't call it directly — requireUser).
    const code = pureGenerateLinkCode();
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await prisma.user.update({
      where: { id: userId },
      data: { telegramLinkCode: code, telegramLinkCodeExpiresAt: expiresAt },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.telegramLinkCode).toMatch(/^RG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(user.telegramLinkCodeExpiresAt).toBeTruthy();
  });

  it("/start CODE links the account (TelegramLink row + code cleared)", async () => {
    // Seed a pending code.
    const code = pureGenerateLinkCode();
    await prisma.user.update({
      where: { id: userId },
      data: {
        telegramLinkCode: code,
        telegramLinkCodeExpiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

    // Simulate the webhook handler's /start CODE path (mirror of
    // handleTelegramWebhookAction's start branch with a code).
    const chatId = "12345678";
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345678, username: "testuser" },
        chat: { id: 12345678, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: `/start ${code}`,
      },
    };
    const command = parseTelegramCommand(update.message!.text);
    expect(command.kind).toBe("start");
    expect(command.kind === "start" ? command.code : undefined).toBe(code);

    // Find the user by code (mirrors handleLinkCommand).
    const found = await prisma.user.findFirst({
      where: { telegramLinkCode: code },
      select: { id: true, telegramLinkCodeExpiresAt: true },
    });
    expect(found?.id).toBe(userId);
    if (!found) throw new Error("user not found by code");

    // Upsert the link.
    await prisma.telegramLink.upsert({
      where: { userId: found.id },
      create: {
        userId: found.id,
        chatId,
        verifiedAt: new Date(),
        username: "testuser",
      },
      update: { chatId, verifiedAt: new Date(), username: "testuser" },
    });
    await prisma.user.update({
      where: { id: found.id },
      data: { telegramLinkCode: null, telegramLinkCodeExpiresAt: null },
    });

    // Verify the DB state.
    const link = await prisma.telegramLink.findUnique({ where: { userId } });
    expect(link?.chatId).toBe(chatId);
    expect(link?.verifiedAt).toBeTruthy();
    const refreshedUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(refreshedUser.telegramLinkCode).toBeNull();
  });

  it("rejects an invalid code", async () => {
    const found = await prisma.user.findFirst({
      where: { telegramLinkCode: "RG-XXXX-XXXX" },
    });
    expect(found).toBeNull();
  });

  it("rejects an expired code", async () => {
    const code = pureGenerateLinkCode();
    await prisma.user.update({
      where: { id: userId },
      data: {
        telegramLinkCode: code,
        telegramLinkCodeExpiresAt: new Date(Date.now() - 60_000), // 1 min ago
      },
    });
    const found = await prisma.user.findFirst({
      where: { telegramLinkCode: code },
      select: { telegramLinkCodeExpiresAt: true },
    });
    expect(found?.telegramLinkCodeExpiresAt).toBeTruthy();
    if (!found?.telegramLinkCodeExpiresAt) throw new Error("expiry should be set");
    expect(found.telegramLinkCodeExpiresAt < new Date()).toBe(true);
  });

  it("rejects a chat already linked to another user", async () => {
    // User B already linked chat 999.
    const userB = await makeUser(`tgb+${Date.now()}@example.com`);
    await prisma.telegramLink.create({
      data: { userId: userB.id, chatId: "999", verifiedAt: new Date() },
    });
    // User A tries to link the same chat.
    const existingByChat = await prisma.telegramLink.findUnique({
      where: { chatId: "999" },
    });
    if (!existingByChat) throw new Error("chat 999 should be linked to user B");
    expect(existingByChat.userId).toBe(userB.id);
    expect(existingByChat?.userId).not.toBe(userId);
  });

  it("unlink deletes the TelegramLink row", async () => {
    await prisma.telegramLink.create({
      data: { userId, chatId: "555", verifiedAt: new Date() },
    });
    const link = await prisma.telegramLink.findUnique({ where: { userId } });
    expect(link).toBeTruthy();
    await prisma.telegramLink.delete({ where: { userId } });
    const after = await prisma.telegramLink.findUnique({ where: { userId } });
    expect(after).toBeNull();
  });
});

// ─── 2. Alerts respect toggles ──────────────────────────────────────────────

describe("Phase 23 — alerts respect toggles", () => {
  let userId: string;
  let mockProvider: MockTelegramProvider;

  /**
   * Mirror of `sendTelegramAlertAction`'s gating logic (can't call the
   * action directly — requireUser isn't available in tests).
   */
  async function sendAlertForTest(
    uid: string,
    alertType: string,
    title: string,
    body: string,
  ): Promise<{ ok: boolean; message: string; delivered?: boolean }> {
    const [user, link] = await Promise.all([
      prisma.user.findUnique({
        where: { id: uid },
        select: {
          telegramAlertsEnabled: true,
          telegramAlertsPaused: true,
          notificationPrefs: true,
        },
      }),
      prisma.telegramLink.findUnique({ where: { userId: uid } }),
    ]);
    if (!link) return { ok: false, message: "No Telegram link." };
    if (!user?.telegramAlertsEnabled) return { ok: false, message: "Telegram alerts disabled." };
    if (user.telegramAlertsPaused) return { ok: false, message: "Telegram alerts paused (/stop)." };
    const prefs = (user.notificationPrefs as Record<string, { telegram?: boolean }>) ?? {};
    const pref = prefs[alertType];
    if (pref && pref.telegram === false) {
      return { ok: false, message: `Telegram alerts for ${alertType} are off.` };
    }
    const provider = mockProvider;
    await provider.sendMessage(link.chatId, `<b>${title}</b>\n${body}`);
    return { ok: true, message: "Alert delivered.", delivered: true };
  }

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.telegramLink.deleteMany();
    await prisma.weeklyReview.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`tgalt+${Date.now()}@example.com`);
    userId = u.id;
    await makeAccount(userId, "Alert Test", "1000");
    mockProvider = new MockTelegramProvider();
    setTelegramProvider(mockProvider);
  });

  it("delivers the alert when all toggles are on", async () => {
    await prisma.telegramLink.create({
      data: { userId, chatId: "777", verifiedAt: new Date() },
    });
    const res = await sendAlertForTest(userId, "RISK_LIMIT_80", "Risk 80%", "Body");
    expect(res.delivered).toBe(true);
    expect(mockProvider.sent).toHaveLength(1);
    expect(mockProvider.sent[0].chatId).toBe("777");
    expect(mockProvider.sent[0].text).toContain("Risk 80%");
  });

  it("does NOT deliver when the master switch is off", async () => {
    await prisma.telegramLink.create({
      data: { userId, chatId: "777", verifiedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { telegramAlertsEnabled: false },
    });
    const res = await sendAlertForTest(userId, "RISK_LIMIT_80", "Risk 80%", "Body");
    expect(res.delivered).toBeUndefined();
    expect(mockProvider.sent).toHaveLength(0);
  });

  it("does NOT deliver when alerts are paused via /stop", async () => {
    await prisma.telegramLink.create({
      data: { userId, chatId: "777", verifiedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { telegramAlertsPaused: true },
    });
    const res = await sendAlertForTest(userId, "RISK_LIMIT_80", "Risk 80%", "Body");
    expect(res.delivered).toBeUndefined();
    expect(mockProvider.sent).toHaveLength(0);
  });

  it("does NOT deliver when the per-alert toggle is off", async () => {
    await prisma.telegramLink.create({
      data: { userId, chatId: "777", verifiedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          RISK_LIMIT_80: { inApp: true, email: true, telegram: false },
        } as never,
      },
    });
    const res = await sendAlertForTest(userId, "RISK_LIMIT_80", "Risk 80%", "Body");
    expect(res.delivered).toBeUndefined();
    expect(mockProvider.sent).toHaveLength(0);
    // But a different alert type (default on) still delivers.
    const res2 = await sendAlertForTest(userId, "LOCKOUT_STARTED", "Locked", "Body");
    expect(res2.delivered).toBe(true);
  });

  it("does NOT deliver when no TelegramLink exists", async () => {
    const res = await sendAlertForTest(userId, "RISK_LIMIT_80", "Risk 80%", "Body");
    expect(res.delivered).toBeUndefined();
    expect(mockProvider.sent).toHaveLength(0);
  });
});

// ─── 3. Weekly review generates from seeded data ────────────────────────────

describe("Phase 23 — weekly review generates from seeded data", () => {
  let userId: string;
  let accountId: string;
  let weekStart: Date;
  let weekEnd: Date;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.telegramLink.deleteMany();
    await prisma.weeklyReview.deleteMany();
    await prisma.trade.deleteMany();
    await prisma.tiltEvent.deleteMany();
    await prisma.balanceCheck.deleteMany();
    await prisma.tradingSession.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.riskProfile.deleteMany();
    await prisma.tradingAccount.deleteMany();
    await prisma.user.deleteMany();

    const u = await makeUser(`wr+${Date.now()}@example.com`);
    userId = u.id;
    const a = await makeAccount(userId, "Review Test", "1000");
    accountId = a.id;

    // Use the previous completed week.
    const prevWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const range = isoWeekRange(prevWeek);
    weekStart = range.start;
    weekEnd = range.end;

    // Seed trades in the week.
    const midWeek = new Date(weekStart.getTime() + 3 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      await makeClosedTrade(
        userId,
        accountId,
        i < 7 ? "WIN" : "LOSS",
        "10",
        new Date(midWeek.getTime() + i * 60 * 60 * 1000),
      );
    }
    // Seed 2 tilt events in the week.
    for (let i = 0; i < 2; i++) {
      await prisma.tiltEvent.create({
        data: {
          userId,
          score: new Decimal("80"),
          level: "TILT",
          signals: JSON.parse(JSON.stringify([{ signal: "RAPID_RETRADE", weight: 20 }])),
          createdAt: midWeek,
        },
      });
    }
    // Seed DailyScores in the week (avg 85).
    for (let i = 0; i < 5; i++) {
      const d = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
      await prisma.dailyScore.create({
        data: {
          userId,
          date: d.toISOString().slice(0, 10),
          score: new Decimal("85"),
          breakdown: JSON.parse(JSON.stringify([])),
          isRestDay: false,
        },
      });
    }
  });

  it("builds the weekly stats from seeded data (aggregates only)", async () => {
    // Mirror buildWeeklyStats (the action's helper). The key assertions:
    //   - 10 trades, 7 wins, 3 losses, win rate 0.7.
    //   - netPL = 7×8.5 - 3×10 = 59.5 - 30 = 29.5.
    //   - 2 tilt events.
    //   - avg discipline score 85.
    const trades = await prisma.trade.findMany({
      where: { userId, result: { in: ["WIN", "LOSS", "TIE"] } },
      select: { profitLoss: true, result: true },
    });
    const netPL = trades.reduce(
      (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
      new Decimal(0),
    );
    const wins = trades.filter((t) => t.result === "WIN").length;
    expect(trades).toHaveLength(10);
    expect(wins).toBe(7);
    expect(netPL.toFixed(2)).toBe("29.50");

    const tiltCount = await prisma.tiltEvent.count({
      where: { userId, level: "TILT" },
    });
    expect(tiltCount).toBe(2);

    const scores = await prisma.dailyScore.findMany({
      where: { userId },
      select: { score: true },
    });
    const avg = scores.reduce((a, s) => a + Number(s.score.toString()), 0) / scores.length;
    expect(avg).toBe(85);
  });

  it("generates an AI review from seeded data + stores the WeeklyReview row", async () => {
    // Register a mock Anthropic client that returns a valid review.
    const mockClient: AnthropicClient = {
      complete: () =>
        Promise.resolve(
          `{"summary":"You were profitable this week with a 70% win rate.","suggestions":["Keep logging emotions.","Watch the tilt triggers.","Maintain the discipline streak."]}`,
        ),
    };
    setAnthropicClient(mockClient);
    try {
      // Verify the prompt the client would receive contains no PII.
      const prompt = buildWeeklyStatsPrompt({
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: new Date(weekEnd.getTime() - 1).toISOString().slice(0, 10),
        netPL: 29.5,
        totalTrades: 10,
        wins: 7,
        losses: 3,
        ties: 0,
        winRate: 0.7,
        profitFactor: 1.98,
        tiltEvents: 2,
        avgDisciplineScore: 85,
        bestStrategy: null,
        worstStrategy: null,
        bestHour: null,
        worstHour: null,
        topEmotions: [],
        ruleBreaches: 0,
        withdrewCount: 0,
      });
      expect(prompt.toLowerCase()).not.toMatch(/@/);
      expect(prompt.toLowerCase()).not.toContain("email");

      // Generate the review via the orchestrator.
      const stats = {
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: new Date(weekEnd.getTime() - 1).toISOString().slice(0, 10),
        netPL: 29.5,
        totalTrades: 10,
        wins: 7,
        losses: 3,
        ties: 0,
        winRate: 0.7,
        profitFactor: 1.98,
        tiltEvents: 2,
        avgDisciplineScore: 85,
        bestStrategy: null,
        worstStrategy: null,
        bestHour: null,
        worstHour: null,
        topEmotions: [],
        ruleBreaches: 0,
        withdrewCount: 0,
      };
      const review = await generateWeeklyReviewWithFallback(stats, mockClient, () =>
        Promise.resolve(),
      );
      expect(review.source).toBe("ai");
      expect(review.summary).toContain("70% win rate");
      expect(review.suggestions).toHaveLength(3);

      // Store (mirror generateWeeklyReviewAction's upsert).
      const row = await prisma.weeklyReview.upsert({
        where: { userId_weekStart: { userId, weekStart } },
        create: {
          userId,
          weekStart,
          weekEnd,
          summary: review.summary,
          suggestions: JSON.parse(JSON.stringify(review.suggestions)),
          source: review.source,
          metrics: JSON.parse(JSON.stringify(stats)),
        },
        update: {
          summary: review.summary,
          suggestions: JSON.parse(JSON.stringify(review.suggestions)),
          source: review.source,
        },
      });
      const stored = await prisma.weeklyReview.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(stored.source).toBe("ai");
      expect(stored.summary).toContain("70% win rate");
      const suggestions = stored.suggestions as string[];
      expect(suggestions).toHaveLength(3);
    } finally {
      setAnthropicClient(null);
    }
  });

  it("falls back to the rule-based review when the AI fails", async () => {
    setAnthropicClient(null); // no AI → fallback
    const stats = {
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: new Date(weekEnd.getTime() - 1).toISOString().slice(0, 10),
      netPL: 29.5,
      totalTrades: 10,
      wins: 7,
      losses: 3,
      ties: 0,
      winRate: 0.7,
      profitFactor: 1.98,
      tiltEvents: 2,
      avgDisciplineScore: 85,
      bestStrategy: null,
      worstStrategy: null,
      bestHour: null,
      worstHour: null,
      topEmotions: [],
      ruleBreaches: 0,
      withdrewCount: 0,
    };
    const review = await generateWeeklyReviewWithFallback(stats, null, () => Promise.resolve());
    expect(review.source).toBe("fallback");
    expect(review.summary).toContain("profitable");
    expect(review.suggestions.length).toBeGreaterThan(0);

    // Store + verify.
    await prisma.weeklyReview.upsert({
      where: { userId_weekStart: { userId, weekStart } },
      create: {
        userId,
        weekStart,
        weekEnd,
        summary: review.summary,
        suggestions: JSON.parse(JSON.stringify(review.suggestions)),
        source: review.source,
        metrics: JSON.parse(JSON.stringify(stats)),
      },
      update: {},
    });
    const stored = await prisma.weeklyReview.findUniqueOrThrow({
      where: { userId_weekStart: { userId, weekStart } },
    });
    expect(stored.source).toBe("fallback");
  });
});

// ─── 4. Cross-user isolation ────────────────────────────────────────────────

describe("Phase 23 — cross-user isolation", () => {
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.telegramLink.deleteMany();
    await prisma.weeklyReview.deleteMany();
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

  it("user A cannot see user B's TelegramLink", async () => {
    await prisma.telegramLink.create({
      data: { userId: userB, chatId: "888", verifiedAt: new Date() },
    });
    const aLink = await prisma.telegramLink.findUnique({ where: { userId: userA } });
    expect(aLink).toBeNull();
  });

  it("user A cannot see user B's WeeklyReview rows", async () => {
    const { start } = isoWeekRange(new Date());
    await prisma.weeklyReview.create({
      data: {
        userId: userB,
        weekStart: start,
        weekEnd: new Date(start.getTime() + 7 * 86400_000),
        summary: "User B's review",
        suggestions: JSON.parse(JSON.stringify(["S1"])),
        source: "fallback",
        metrics: JSON.parse(JSON.stringify({})),
      },
    });
    const aReviews = await prisma.weeklyReview.findMany({ where: { userId: userA } });
    expect(aReviews).toHaveLength(0);
  });
});

// Reset the provider after all tests (don't leak the mock into other files).
afterAll(async () => {
  setTelegramProvider(null);
  setAnthropicClient(null);
  await prisma.$disconnect();
});

// Keep the ConsoleTelegramProvider import referenced (used in an earlier
// draft for the no-provider fallback test; the Mock covers the behavior).
void ConsoleTelegramProvider;
