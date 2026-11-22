/**
 * Phase 30.4 — integration tests for the scheduled news-briefing sweep.
 *
 * Uses the live DB in .env. The sweep is called directly (no HTTP/CRON_SECRET
 * needed here); market snapshot, edge report and email are mocked so the test
 * stays deterministic and offline. Telegram uses the real action with an
 * injected mock provider, so opt-in gating is exercised end to end.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();
/** 08:05 UTC matches the default 08:00 briefing window. */
const BRIEFING_NOW = new Date("2026-11-21T08:05:00.000Z");

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const sendEmail = vi.fn(async (_payload: unknown) => ({ messageId: "test" }));
vi.mock("@/lib/email", () => ({ sendEmail: (payload: unknown) => sendEmail(payload) }));

vi.mock("@/server/lib/market-snapshot", () => ({
  buildMarketSnapshot: vi.fn(async () => ({
    rating: "CAUTION",
    isStale: false,
    pairs: [{ rating: "CAUTION" }],
    nextNews: { title: "US CPI", currency: "USD", minutesTo: 30 },
  })),
}));

vi.mock("@/server/lib/market-edge", () => ({
  getMarketEdgeReport: vi.fn(async () => ({
    totalTrades: 3,
    insights: [{ id: "plan-rate", text: "Most of your trades were logged outside the plan." }],
  })),
}));

import { setTelegramProvider, type TelegramProvider } from "@/lib/telegram/provider";
import { sendNewsBriefings } from "@/server/lib/news-briefing";
import { BRIEFING_DISCLAIMER } from "@/lib/news/briefing";

const telegramMessages: Array<{ chatId: string; text: string }> = [];
const mockTelegramProvider: TelegramProvider = {
  name: "briefing-test",
  async sendMessage(chatId, text) {
    telegramMessages.push({ chatId, text });
    return { messageId: 1 };
  },
  verifyWebhookSignature() {
    return true;
  },
};
setTelegramProvider(mockTelegramProvider);

async function makeUser(email: string, prefs: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email,
      name: "Briefing Test",
      passwordHash: await argon2.hash("TestPass123!"),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
      notificationPrefs: prefs as Prisma.InputJsonValue,
    },
  });
}

beforeEach(async () => {
  telegramMessages.length = 0;
  sendEmail.mockClear();
  await prisma.notification.deleteMany();
  await prisma.telegramLink.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.newsArticle.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("sendNewsBriefings", () => {
  it("does nothing for users who never opted in, but still audits the run", async () => {
    await makeUser(`plain-${Date.now()}@example.com`);

    const result = await sendNewsBriefings(BRIEFING_NOW);

    expect(result.ok).toBe(true);
    expect(result.eligibleUsers).toBe(0);
    expect(result.inAppSent).toBe(0);
    expect(result.emailSent).toBe(0);
    expect(result.telegramSent).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(telegramMessages).toHaveLength(0);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: "BRIEFING" } });
    expect(run.status).toBe("OK");
  });

  it("delivers to all three enabled channels and records a short descriptive briefing", async () => {
    const user = await makeUser(`all-${Date.now()}@example.com`, {
      NEWS_BRIEFING: { inApp: true, email: true, telegram: true },
    });
    await prisma.telegramLink.create({
      data: { userId: user.id, chatId: `chat-${Date.now()}` },
    });

    const result = await sendNewsBriefings(BRIEFING_NOW);

    expect(result.ok).toBe(true);
    expect(result.eligibleUsers).toBe(1);
    expect(result.inAppSent).toBe(1);
    expect(result.emailSent).toBe(1);
    expect(result.telegramSent).toBe(1);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: user.id, type: "NEWS_BRIEFING" },
    });
    expect(notification.body).toContain("USD US CPI in about 30 minutes.");
    expect(notification.body).toContain("Latest market rating: CAUTION.");
    expect(notification.body).toContain("Most of your trades were logged outside the plan.");
    expect(notification.body.endsWith(BRIEFING_DISCLAIMER)).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(telegramMessages).toHaveLength(1);
    expect(telegramMessages[0].text).toContain("USD US CPI");

    const run = await prisma.agentRun.findFirstOrThrow({ where: { kind: "BRIEFING" } });
    expect(run.status).toBe("OK");
    expect(run.itemsStored).toBe(3);
  });

  it("honours per-channel toggles — email-only users never get Telegram or in-app rows", async () => {
    await makeUser(`email-${Date.now()}@example.com`, {
      NEWS_BRIEFING: { inApp: false, email: true, telegram: false },
    });

    const result = await sendNewsBriefings(BRIEFING_NOW);

    expect(result.emailSent).toBe(1);
    expect(result.inAppSent).toBe(0);
    expect(result.telegramSent).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(telegramMessages).toHaveLength(0);
  });

  it("only sweeps opted-in users and keeps Telegram gated when no link exists", async () => {
    const opted = await makeUser(`opted-${Date.now()}@example.com`, {
      NEWS_BRIEFING: { inApp: true, email: false, telegram: true },
    });
    await makeUser(`other-${Date.now()}@example.com`);

    const result = await sendNewsBriefings(BRIEFING_NOW);

    expect(result.eligibleUsers).toBe(1);
    expect(result.inAppSent).toBe(1);
    expect(result.telegramSent).toBe(0); // opted in but no TelegramLink
    const rows = await prisma.notification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(opted.id);
  });

  it("skips users outside their chosen time window", async () => {
    await makeUser(`later-${Date.now()}@example.com`, {
      NEWS_BRIEFING: {
        inApp: true,
        email: false,
        telegram: false,
        briefingTime: "09:00",
        briefingFrequency: "DAILY",
      },
    });

    const result = await sendNewsBriefings(BRIEFING_NOW);

    expect(result.eligibleUsers).toBe(0);
    expect(result.inAppSent).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("does not deliver twice when the cron is invoked again in the same window", async () => {
    await makeUser(`once-${Date.now()}@example.com`, {
      NEWS_BRIEFING: { inApp: true, email: false, telegram: false },
    });

    const first = await sendNewsBriefings(BRIEFING_NOW);
    const second = await sendNewsBriefings(BRIEFING_NOW);

    expect(first.inAppSent).toBe(1);
    expect(second.inAppSent).toBe(0);
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "NEWS_BRIEFING_SENT" } })).toBe(1);
  });
});
