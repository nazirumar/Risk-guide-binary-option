/**
 * Phase 30.2 — integration tests for the real AI-coach server actions.
 *
 * Calls the exported actions from `src/server/actions/coach.ts` with
 * `requireUser` mocked to a test userId (same pattern as the Phase 25 action
 * tests), using the live DB in .env. Covers opt-in gating, quota, userId
 * scoping, the data-sharing disclosure payload and audit logging.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

const prisma = new PrismaClient();

// Server actions call revalidatePath; there is no Next static-generation
// store inside Vitest, so stub it (the same actions work in the app itself).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

let currentTestUserId: string | null = null;
vi.mock("@/server/lib/require-user", () => ({
  requireUser: async () => {
    if (!currentTestUserId) throw new Error("test userId not set");
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: currentTestUserId },
      select: {
        id: true,
        email: true,
        name: true,
        isOnboarded: true,
        emailVerified: true,
        timezone: true,
        baseCurrency: true,
      },
    });
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      isOnboarded: u.isOnboarded,
      emailVerified: u.emailVerified,
      timezone: u.timezone,
      baseCurrency: u.baseCurrency,
    };
  },
}));

import {
  createCoachConversationAction,
  getCoachConversationAction,
  listCoachConversationsAction,
  sendCoachMessageAction,
  updateCoachSettingsAction,
} from "@/server/actions/coach";
import { setCoachAIClient, COACH_DISCLAIMER } from "@/lib/ai/coach";

function makeFormData(obj: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return fd;
}

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: "Coach Test",
      passwordHash: await argon2.hash("TestPass123!"),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
}

async function makeAccount(userId: string) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      name: "Coach Account",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
}

beforeEach(async () => {
  await prisma.coachMessage.deleteMany();
  await prisma.coachConversation.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.tiltEvent.deleteMany();
  await prisma.dailyScore.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.tradingSession.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.balanceCheck.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.user.deleteMany();
  currentTestUserId = null;
  // Deterministic: no network call from the actions unless a test opts in.
  setCoachAIClient(null);
});

afterAll(async () => {
  setCoachAIClient(null);
  await prisma.$disconnect();
});

describe("Phase 30.2 — AI coach actions", () => {
  it("blocks sending until the user opts in", async () => {
    const user = await makeUser(`coach-off-${Date.now()}@example.com`);
    currentTestUserId = user.id;

    const res = await sendCoachMessageAction({ content: "How am I doing?" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Enable the AI journal coach/);
    expect(await prisma.coachConversation.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.coachMessage.count()).toBe(0);

    const created = await createCoachConversationAction();
    expect(created.ok).toBe(false);
  });

  it("opts in via the settings action and writes an audit row", async () => {
    const user = await makeUser(`coach-on-${Date.now()}@example.com`);
    currentTestUserId = user.id;

    const res = await updateCoachSettingsAction(
      makeFormData({ aiCoachEnabled: "true", coachIncludeNotes: "false" }),
    );
    expect(res.ok).toBe(true);
    expect(res.data?.enabled).toBe(true);
    expect(res.data?.includeNotes).toBe(false);

    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { aiCoachEnabled: true, coachIncludeNotes: true },
    });
    expect(fresh.aiCoachEnabled).toBe(true);
    expect(fresh.coachIncludeNotes).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { userId: user.id, action: "COACH_SETTINGS_UPDATED" },
      }),
    ).toBe(1);
  });

  it("stores a fallback reply with the shared aggregate payload and disclaimer", async () => {
    const user = await makeUser(`coach-fallback-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    const account = await makeAccount(user.id);
    await prisma.trade.create({
      data: {
        userId: user.id,
        tradingAccountId: account.id,
        asset: "EUR/USD",
        direction: "CALL",
        stake: new Decimal("10"),
        payoutPercent: new Decimal("0.85"),
        expiryMinutes: 5,
        result: "WIN",
        profitLoss: new Decimal("8.5"),
        emotion: "CALM",
        followedPlan: true,
        openedAt: new Date(),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { aiCoachEnabled: true } });

    const res = await sendCoachMessageAction({ content: "How am I doing?" });
    expect(res.ok).toBe(true);
    expect(res.data?.reply.source).toBe("fallback");
    expect(res.data?.reply.content).toContain(COACH_DISCLAIMER);
    expect(res.data?.usedToday).toBe(1);

    const assistant = await prisma.coachMessage.findFirst({
      where: { role: "assistant" },
    });
    expect(assistant).not.toBeNull();
    expect(assistant?.content).toContain(COACH_DISCLAIMER);
    const shared = assistant?.sharedContext as {
      stats?: {
        totalTrades?: number;
        wins?: number;
        netPL?: number;
        periodStart?: string;
      };
      notes?: string[];
    };
    expect(shared?.stats?.totalTrades).toBe(1);
    expect(shared?.stats?.wins).toBe(1);
    expect(shared?.stats?.netPL).toBe(8.5);
    expect(shared?.stats?.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(shared?.notes).toBeUndefined();

    const userRow = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { coachMessagesToday: true, coachLastMessageAt: true },
    });
    expect(userRow.coachMessagesToday).toBe(1);
    expect(userRow.coachLastMessageAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { userId: user.id, action: "COACH_MESSAGE_SENT" } }),
    ).toBe(1);
  });

  it("includes the user's own imported rows in the disclosed aggregate", async () => {
    const user = await makeUser(`coach-import-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    const account = await makeAccount(user.id);
    const batch = await prisma.importBatch.create({
      data: {
        userId: user.id,
        source: "CSV",
        status: "COMMITTED",
        rows: {} as never,
        checksum: `coach-import-${Date.now()}`,
        fileName: "statement.csv",
      },
    });
    await prisma.trade.create({
      data: {
        userId: user.id,
        tradingAccountId: account.id,
        asset: "EUR/USD",
        direction: "CALL",
        stake: new Decimal("10"),
        payoutPercent: new Decimal("0.85"),
        expiryMinutes: 5,
        result: "WIN",
        profitLoss: new Decimal("7.25"),
        openedAt: new Date(),
        source: "CSV",
        externalId: "coach-import-trade",
        importBatchId: batch.id,
      },
    });
    await prisma.transaction.create({
      data: {
        tradingAccountId: account.id,
        type: "DEPOSIT",
        amount: new Decimal("100"),
        source: "CSV",
        externalId: "coach-import-transaction",
        importBatchId: batch.id,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { aiCoachEnabled: true } });

    const res = await sendCoachMessageAction({ content: "How am I doing?" });
    expect(res.ok).toBe(true);

    const assistant = await prisma.coachMessage.findFirst({ where: { role: "assistant" } });
    const shared = assistant?.sharedContext as {
      imports?: {
        batches?: number;
        importedTrades?: number;
        importedTransactions?: number;
        netPL?: number;
      };
    };
    expect(shared?.imports).toMatchObject({
      batches: 1,
      importedTrades: 1,
      importedTransactions: 1,
      netPL: 7.25,
    });
    expect(assistant?.content).toContain("1 imported trade rows");
  });

  it("shares notes only with the separate opt-in and scrubs them from the prompt", async () => {
    const user = await makeUser(`coach-notes-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        aiCoachEnabled: true,
        coachIncludeNotes: true,
        dailyJournal: { [new Date().toISOString().slice(0, 10)]: "Felt rushed today." },
      },
    });

    let capturedPrompt = "";
    setCoachAIClient({
      name: "test",
      complete: async (prompt) => {
        capturedPrompt = prompt;
        return "Your notes show a consistent routine — keep recording them.";
      },
    });

    const res = await sendCoachMessageAction({
      content: "Any patterns? (my mail is me@example.com)",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.reply.source).toBe("ai");
    expect(capturedPrompt).toContain("Felt rushed today.");
    expect(capturedPrompt).not.toContain("me@example.com");
    expect(capturedPrompt).toContain("[email removed]");
    expect(capturedPrompt).toContain("The user's own journal notes");
    expect(capturedPrompt).not.toContain("[number removed]: Felt rushed");
    expect(capturedPrompt).not.toContain(user.email);

    const assistant = await prisma.coachMessage.findFirst({ where: { role: "assistant" } });
    const shared = assistant?.sharedContext as { notes?: string[] };
    expect(shared?.notes?.length).toBe(1);
  });

  it("enforces the daily quota and resets it on a new UTC day", async () => {
    const user = await makeUser(`coach-quota-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        aiCoachEnabled: true,
        coachMessagesToday: 20,
        coachLastMessageAt: new Date(),
      },
    });

    const blocked = await sendCoachMessageAction({ content: "One more question" });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/Daily coach limit/);
    expect(await prisma.coachMessage.count()).toBe(0);

    await prisma.user.update({
      where: { id: user.id },
      data: { coachLastMessageAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const allowed = await sendCoachMessageAction({ content: "A fresh day" });
    expect(allowed.ok).toBe(true);
    expect(allowed.data?.usedToday).toBe(1);
  });

  it("scopes conversations and messages by userId", async () => {
    const owner = await makeUser(`coach-owner-${Date.now()}@example.com`);
    const other = await makeUser(`coach-other-${Date.now()}@example.com`);
    currentTestUserId = owner.id;
    await prisma.user.update({ where: { id: owner.id }, data: { aiCoachEnabled: true } });

    const sent = await sendCoachMessageAction({ content: "Private reflection" });
    expect(sent.ok).toBe(true);
    const conversationId = sent.data!.conversationId;

    currentTestUserId = other.id;
    await prisma.user.update({ where: { id: other.id }, data: { aiCoachEnabled: true } });

    expect((await listCoachConversationsAction()).data).toEqual([]);
    expect((await getCoachConversationAction(conversationId)).ok).toBe(false);
    const crossUser = await sendCoachMessageAction({
      conversationId,
      content: "Let me in",
    });
    expect(crossUser.ok).toBe(false);
    expect(crossUser.message).toMatch(/not found/);
    expect(await prisma.coachMessage.count({ where: { conversationId } })).toBe(2);

    currentTestUserId = owner.id;
    const own = await getCoachConversationAction(conversationId);
    expect(own.ok).toBe(true);
    expect(own.data?.messages).toHaveLength(2);
  });

  it("cascades conversation and message deletion when the owner is removed", async () => {
    const user = await makeUser(`coach-cascade-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    await prisma.user.update({ where: { id: user.id }, data: { aiCoachEnabled: true } });
    const sent = await sendCoachMessageAction({ content: "Delete me" });
    expect(sent.ok).toBe(true);
    expect(await prisma.coachMessage.count()).toBe(2);

    await prisma.user.delete({ where: { id: user.id } });
    currentTestUserId = null;
    expect(await prisma.coachConversation.count()).toBe(0);
    expect(await prisma.coachMessage.count()).toBe(0);
  });
});
