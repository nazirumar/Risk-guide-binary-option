"use server";

import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount } from "@/server/actions/active-account";
import { z } from "zod";

const startSessionSchema = z.object({
  tradingAccountId: z.string().min(1),
  mood: z.enum(["FOCUSED", "CALM", "TIRED", "FRUSTRATED", "CONFIDENT", "REVENGEFUL"]).optional(),
  checklistConfirmed: z.boolean(),
});

const endSessionSchema = z.object({
  sessionId: z.string().min(1),
  notes: z.string().max(2000).optional(),
  rating: z.number().int().min(1).max(5).optional(),
});

export type SessionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  sessionId?: string;
};

export async function startSessionAction(formData: FormData): Promise<SessionResult> {
  const { userId } = await requireUser();
  const parsed = startSessionSchema.safeParse({
    tradingAccountId: formData.get("tradingAccountId"),
    mood: formData.get("mood") || undefined,
    checklistConfirmed: formData.get("checklistConfirmed") === "true",
  });
  if (!parsed.success) {
    return { ok: false, message: "Invalid input.", fieldErrors: {} };
  }
  if (!parsed.data.checklistConfirmed) {
    return {
      ok: false,
      message: "You must complete the pre-trade checklist before starting a session.",
    };
  }

  // Check if there's already an active session.
  const active = await db.tradingSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (active) return { ok: false, message: "You already have an active session. End it first." };

  const account = await db.tradingAccount.findFirst({
    where: { id: parsed.data.tradingAccountId, userId },
    select: { currentBalance: true },
  });
  if (!account) return { ok: false, message: "Account not found." };

  const session = await db.tradingSession.create({
    data: {
      userId,
      tradingAccountId: parsed.data.tradingAccountId,
      startedAt: new Date(),
      startBalance: account.currentBalance,
      mood: parsed.data.mood,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "SESSION_STARTED",
      entity: "TradingSession",
      entityId: session.id,
      meta: { mood: parsed.data.mood },
    },
  });

  revalidatePath("/app/goals");
  return { ok: true, message: "Session started.", sessionId: session.id };
}

export async function endSessionAction(formData: FormData): Promise<SessionResult> {
  const { userId } = await requireUser();
  const parsed = endSessionSchema.safeParse({
    sessionId: formData.get("sessionId"),
    notes: formData.get("notes") || undefined,
    rating: formData.get("rating") ? Number(formData.get("rating")) : undefined,
  });
  if (!parsed.success) {
    return { ok: false, message: "Invalid input." };
  }

  const session = await db.tradingSession.findFirst({
    where: { id: parsed.data.sessionId, userId, endedAt: null },
    select: { id: true, tradingAccountId: true, startedAt: true, startBalance: true },
  });
  if (!session) return { ok: false, message: "No active session found." };

  const account = await db.tradingAccount.findFirst({
    where: { id: session.tradingAccountId, userId },
    select: { currentBalance: true },
  });
  const endBalance = account?.currentBalance ?? session.startBalance;

  await db.tradingSession.update({
    where: { id: session.id },
    data: {
      endedAt: new Date(),
      endBalance,
      notes: parsed.data.notes ?? null,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "SESSION_ENDED",
      entity: "TradingSession",
      entityId: session.id,
      meta: { endBalance: endBalance.toString(), rating: parsed.data.rating },
    },
  });

  revalidatePath("/app/goals");
  return { ok: true, message: "Session ended." };
}

export async function getActiveSession() {
  const { userId } = await requireUser();
  return db.tradingSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      tradingAccountId: true,
      startedAt: true,
      startBalance: true,
      mood: true,
    },
  });
}

/**
 * Fetch session summary: P/L, win rate, trade count, rule breaches.
 * Auto-links trades where openedAt >= session.startedAt AND (closedAt <=
 * session.endedAt OR session is still active).
 */
export async function getSessionSummary(sessionId: string) {
  const { userId } = await requireUser();
  const session = await db.tradingSession.findFirst({
    where: { id: sessionId, userId },
    select: {
      id: true,
      tradingAccountId: true,
      startedAt: true,
      endedAt: true,
      startBalance: true,
      endBalance: true,
      notes: true,
      mood: true,
    },
  });
  if (!session) return null;

  const endTime = session.endedAt ?? new Date();
  const trades = await db.trade.findMany({
    where: {
      userId,
      tradingAccountId: session.tradingAccountId,
      result: { in: ["WIN", "LOSS", "TIE"] },
      openedAt: { gte: session.startedAt, lte: endTime },
    },
    select: { profitLoss: true, result: true, followedPlan: true, asset: true, direction: true },
  });

  const netPL = trades.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
  const wins = trades.filter((t) => t.result === "WIN").length;
  const losses = trades.filter((t) => t.result === "LOSS").length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const brokePlan = trades.filter((t) => !t.followedPlan).length;

  const startBal = Number(session.startBalance.toString());
  const endBal = session.endBalance ? Number(session.endBalance.toString()) : startBal + netPL;

  return {
    ...session,
    startBalance: startBal,
    endBalance: endBal,
    netPL,
    wins,
    losses,
    winRate,
    tradeCount: trades.length,
    brokePlanCount: brokePlan,
  };
}
