"use server";

/**
 * Phase 30.2 — opt-in AI journal coach server actions.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by `userId` from
 * `requireUser()`. rule #8: state changes are audited. rule #11: every AI
 * reply carries the risk disclaimer.
 *
 * PRIVACY: the model receives only the user's OWN aggregates and (only with
 * the separate `coachIncludeNotes` opt-in) their OWN journal notes. Email,
 * name, screenshots and other users' rows are never selected or sent. The
 * exact payload is stored on the assistant message for the UI disclosure.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { rateLimitCoachMessage } from "@/lib/rate-limit";
import {
  coachConversationTitle,
  generateCoachReplyWithFallback,
  getCoachAIClient,
  sanitizeCoachInput,
  shouldResetDailyCount,
  utcDayKey,
  type CoachContext,
  type CoachHistoryTurn,
  type CoachReply,
  type CoachStatsContext,
} from "@/lib/ai/coach";

// ─── Result types ──────────────────────────────────────────────────────────

export type CoachActionResult<T = undefined> = {
  ok: boolean;
  message: string;
  data?: T;
};

export type CoachConversationRow = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
};

export type CoachMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sharedContext: unknown | null;
  source: "ai" | "fallback" | null;
  createdAt: Date;
};

export type CoachSettings = {
  enabled: boolean;
  includeNotes: boolean;
  quota: number;
  usedToday: number;
};

// ─── Config ────────────────────────────────────────────────────────────────

function dailyQuota(): number {
  const raw = process.env.COACH_MAX_MESSAGES_PER_DAY;
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(200, Math.max(1, parsed));
}

const COACH_WINDOW_DAYS = 30;
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 500;

const sendMessageSchema = z.object({
  conversationId: z.string().min(1).optional().nullable(),
  content: z.string().trim().min(1, "Write a question first.").max(2000),
});

const settingsSchema = z.object({
  aiCoachEnabled: z.enum(["true", "false"]),
  coachIncludeNotes: z.enum(["true", "false"]),
});

// ─── Settings ──────────────────────────────────────────────────────────────

/** Read the coach settings + today's quota usage for the current user. */
export async function getCoachSettingsAction(): Promise<CoachActionResult<CoachSettings>> {
  const { userId } = await requireUser();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      aiCoachEnabled: true,
      coachIncludeNotes: true,
      coachMessagesToday: true,
      coachLastMessageAt: true,
    },
  });
  const reset = shouldResetDailyCount(user?.coachLastMessageAt ?? null);
  return {
    ok: true,
    message: "ok",
    data: {
      enabled: user?.aiCoachEnabled ?? false,
      includeNotes: user?.coachIncludeNotes ?? false,
      quota: dailyQuota(),
      usedToday: reset ? 0 : (user?.coachMessagesToday ?? 0),
    },
  };
}

/** Opt-in toggle + the separate "include my notes" toggle. Both default off. */
export async function updateCoachSettingsAction(
  formData: FormData,
): Promise<CoachActionResult<CoachSettings>> {
  const { userId } = await requireUser();
  const parsed = settingsSchema.safeParse({
    aiCoachEnabled: String(formData.get("aiCoachEnabled") ?? "false"),
    coachIncludeNotes: String(formData.get("coachIncludeNotes") ?? "false"),
  });
  if (!parsed.success) {
    return { ok: false, message: "Invalid coach settings." };
  }
  const enabled = parsed.data.aiCoachEnabled === "true";
  const includeNotes = parsed.data.coachIncludeNotes === "true";

  await db.user.update({
    where: { id: userId },
    data: { aiCoachEnabled: enabled, coachIncludeNotes: includeNotes },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "COACH_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: { aiCoachEnabled: enabled, coachIncludeNotes: includeNotes },
    },
  });
  revalidatePath("/app/reports");
  revalidatePath("/app/settings");
  return {
    ok: true,
    message: "Coach settings saved.",
    data: {
      enabled,
      includeNotes,
      quota: dailyQuota(),
      usedToday: 0,
    },
  };
}

// ─── Conversations ─────────────────────────────────────────────────────────

/** List the current user's conversations only. */
export async function listCoachConversationsAction(): Promise<
  CoachActionResult<CoachConversationRow[]>
> {
  const { userId } = await requireUser();
  const rows = await db.coachConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return {
    ok: true,
    message: "ok",
    data: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r._count.messages,
    })),
  };
}

/** Load one conversation + messages, only if the current user owns it. */
export async function getCoachConversationAction(
  conversationId: string,
): Promise<CoachActionResult<{ conversation: CoachConversationRow; messages: CoachMessageRow[] }>> {
  const { userId } = await requireUser();
  const row = await db.coachConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 80,
        select: {
          id: true,
          role: true,
          content: true,
          sharedContext: true,
          source: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row) return { ok: false, message: "Conversation not found." };

  return {
    ok: true,
    message: "ok",
    data: {
      conversation: {
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messageCount: row._count.messages,
      },
      messages: row.messages.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        sharedContext: (m.sharedContext as unknown) ?? null,
        source: (m.source as "ai" | "fallback" | null) ?? null,
        createdAt: m.createdAt,
      })),
    },
  };
}

/** Create an empty conversation (optional starting title). */
export async function createCoachConversationAction(
  title?: string,
): Promise<CoachActionResult<CoachConversationRow>> {
  const { userId } = await requireUser();
  const optedIn = await db.user.findUnique({
    where: { id: userId },
    select: { aiCoachEnabled: true },
  });
  if (!optedIn?.aiCoachEnabled) {
    return { ok: false, message: "Enable the AI journal coach in Settings first." };
  }
  const row = await db.coachConversation.create({
    data: { userId, title: coachConversationTitle(title ?? "New reflection") },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "COACH_CONVERSATION_CREATED",
      entity: "CoachConversation",
      entityId: row.id,
      meta: {},
    },
  });
  revalidatePath("/app/reports");
  return {
    ok: true,
    message: "Conversation created.",
    data: {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: 0,
    },
  };
}

// ─── Context builder ───────────────────────────────────────────────────────

/**
 * Build the aggregate payload from the user's OWN rows. Never selects email,
 * name, screenshots, or another user's data. Notes are included only when the
 * user explicitly enabled `coachIncludeNotes`.
 */
async function buildCoachContext(
  userId: string,
  includeNotes: boolean,
  now: Date,
): Promise<CoachContext> {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - COACH_WINDOW_DAYS);
  from.setUTCHours(0, 0, 0, 0);

  const importedSources = ["CSV", "PDF", "IMAGE"];
  const [
    trades,
    tiltEvents,
    ruleBreaches,
    dailyScores,
    user,
    sessionNotes,
    importedBatches,
    importedTrades,
    importedTransactions,
    lastImport,
  ] = await Promise.all([
    db.trade.findMany({
      where: {
        userId,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: from, lte: now },
      },
      select: {
        result: true,
        profitLoss: true,
        emotion: true,
        followedPlan: true,
        setupNotes: includeNotes,
        openedAt: true,
      },
      take: 2000,
    }),
    db.tiltEvent.count({ where: { userId, createdAt: { gte: from, lte: now } } }),
    db.auditLog.count({
      where: {
        userId,
        action: { in: ["LOCKOUT_OVERRIDDEN", "NEWS_WARNING_OVERRIDDEN", "AVOID_WARNING_IGNORED"] },
        createdAt: { gte: from, lte: now },
      },
    }),
    db.dailyScore.findMany({
      where: { userId, date: { gte: utcDayKey(from), lte: utcDayKey(now) } },
      select: { score: true },
    }),
    db.user.findUnique({ where: { id: userId }, select: { dailyJournal: true } }),
    includeNotes
      ? db.tradingSession.findMany({
          where: { userId, startedAt: { gte: from, lte: now }, notes: { not: null } },
          select: { notes: true },
          orderBy: { startedAt: "desc" },
          take: MAX_NOTES,
        })
      : Promise.resolve([]),
    db.importBatch.count({
      where: { userId, status: "COMMITTED", createdAt: { gte: from, lte: now } },
    }),
    db.trade.findMany({
      where: {
        userId,
        source: { in: importedSources },
        openedAt: { gte: from, lte: now },
      },
      select: { profitLoss: true },
      take: 2000,
    }),
    db.transaction.count({
      where: {
        source: { in: importedSources },
        tradingAccount: { userId },
        createdAt: { gte: from, lte: now },
      },
    }),
    db.importBatch.findFirst({
      where: { userId, status: "COMMITTED", createdAt: { gte: from, lte: now } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  let netPl = new Decimal(0);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let followed = 0;
  const emotionCounts = new Map<string, number>();
  for (const t of trades) {
    netPl = netPl.plus(t.profitLoss);
    if (t.result === "WIN") wins++;
    else if (t.result === "LOSS") losses++;
    else ties++;
    if (t.followedPlan) followed++;
    if (t.emotion) emotionCounts.set(t.emotion, (emotionCounts.get(t.emotion) ?? 0) + 1);
  }
  const total = trades.length;
  const scoreValues = dailyScores.map((d) => Number(d.score)).filter(Number.isFinite);
  const avgDisciplineScore =
    scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : null;

  const stats: CoachStatsContext = {
    periodStart: utcDayKey(from),
    periodEnd: utcDayKey(now),
    totalTrades: total,
    wins,
    losses,
    ties,
    winRate: total > 0 ? wins / total : 0,
    netPL: netPl.toNumber(),
    avgDisciplineScore,
    tiltEvents,
    ruleBreaches,
    followedPlanRate: total > 0 ? followed / total : null,
    topEmotions: [...emotionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([emotion, count]) => ({ emotion, count })),
  };

  const context: CoachContext = { stats };
  if (importedBatches > 0 || importedTrades.length > 0 || importedTransactions > 0) {
    let importNetPl = new Decimal(0);
    for (const row of importedTrades) importNetPl = importNetPl.plus(row.profitLoss);
    context.imports = {
      batches: importedBatches,
      importedTrades: importedTrades.length,
      importedTransactions,
      netPL: importNetPl.toNumber(),
      lastImportedDay: lastImport ? utcDayKey(lastImport.createdAt) : null,
    };
  }
  if (includeNotes) {
    const notes: string[] = [];
    const journal = (user?.dailyJournal as Record<string, string> | null) ?? {};
    for (const [date, text] of Object.entries(journal)) {
      if (date >= stats.periodStart && date <= stats.periodEnd && typeof text === "string") {
        notes.push(`${date}: ${text.slice(0, MAX_NOTE_CHARS)}`);
        if (notes.length >= MAX_NOTES) break;
      }
    }
    for (const s of sessionNotes) {
      if (notes.length >= MAX_NOTES) break;
      if (s.notes) notes.push(s.notes.slice(0, MAX_NOTE_CHARS));
    }
    for (const t of trades) {
      if (notes.length >= MAX_NOTES) break;
      if ("setupNotes" in t && t.setupNotes) {
        notes.push(t.setupNotes.slice(0, MAX_NOTE_CHARS));
      }
    }
    if (notes.length > 0) context.notes = notes;
  }
  return context;
}

// ─── Send a message ────────────────────────────────────────────────────────

/**
 * Send a coach message. Checks: opt-in → rate limit → daily quota →
 * conversation ownership → context build → AI (with fallback) → persisted
 * user + assistant messages → audit. Every failure returns a typed result;
 * nothing is stored when a precondition fails.
 */
export async function sendCoachMessageAction(input: {
  conversationId?: string | null;
  content: string;
}): Promise<
  CoachActionResult<{ conversationId: string; reply: CoachReply; usedToday: number; quota: number }>
> {
  const { userId } = await requireUser();

  const parsed = sendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid message." };
  }
  const question = sanitizeCoachInput(parsed.data.content);
  if (question.length === 0) return { ok: false, message: "Write a question first." };

  const flags = await db.user.findUnique({
    where: { id: userId },
    select: {
      aiCoachEnabled: true,
      coachIncludeNotes: true,
      coachMessagesToday: true,
      coachLastMessageAt: true,
    },
  });
  if (!flags?.aiCoachEnabled) {
    return { ok: false, message: "Enable the AI journal coach in Settings first." };
  }

  const limited = await rateLimitCoachMessage(userId);
  if (!limited.success) {
    return { ok: false, message: "Too many messages — wait a few minutes and try again." };
  }

  const now = new Date();
  const quota = dailyQuota();
  const reset = shouldResetDailyCount(flags.coachLastMessageAt, now);
  const usedBefore = reset ? 0 : flags.coachMessagesToday;
  if (usedBefore >= quota) {
    return {
      ok: false,
      message: `Daily coach limit reached (${quota} messages). It resets tomorrow.`,
    };
  }

  // Verify ownership before touching an existing conversation.
  let conversationId = parsed.data.conversationId ?? null;
  if (conversationId) {
    const owned = await db.coachConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!owned) return { ok: false, message: "Conversation not found." };
  }

  const history: CoachHistoryTurn[] = conversationId
    ? (
        await db.coachMessage.findMany({
          where: { conversationId, conversation: { userId } },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: { role: true, content: true },
        })
      )
        .reverse()
        .map((m) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        }))
    : [];

  const context = await buildCoachContext(userId, flags.coachIncludeNotes, now);
  const reply = await generateCoachReplyWithFallback(
    context,
    question,
    getCoachAIClient(),
    history,
  );

  if (!conversationId) {
    const created = await db.coachConversation.create({
      data: { userId, title: coachConversationTitle(question) },
    });
    conversationId = created.id;
    await db.auditLog.create({
      data: {
        userId,
        action: "COACH_CONVERSATION_CREATED",
        entity: "CoachConversation",
        entityId: created.id,
        meta: { source: "sendCoachMessageAction" },
      },
    });
  }

  await db.coachMessage.create({
    data: { conversationId, role: "user", content: question },
  });
  await db.coachMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: reply.content,
      source: reply.source,
      sharedContext: JSON.parse(JSON.stringify(reply.sharedContext)),
    },
  });
  await db.coachConversation.update({
    where: { id: conversationId },
    data: { updatedAt: now },
  });
  await db.user.update({
    where: { id: userId },
    data: {
      coachMessagesToday: usedBefore + 1,
      coachLastMessageAt: now,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "COACH_MESSAGE_SENT",
      entity: "CoachConversation",
      entityId: conversationId,
      meta: { source: reply.source, notesShared: Boolean(context.notes?.length) },
    },
  });

  revalidatePath("/app/reports");
  return {
    ok: true,
    message: "Reply ready.",
    data: {
      conversationId,
      reply,
      usedToday: usedBefore + 1,
      quota,
    },
  };
}
