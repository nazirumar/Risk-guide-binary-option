"use server";

/**
 * Phase 23 — AI weekly review server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #8:
 * state changes are audited. PRIVACY: only aggregated stats are sent to
 * the AI — no email, name, or screenshots — enforced by the pure
 * `buildWeeklyStatsPrompt` + verified by a unit test that inspects the
 * payload.)
 *
 * Four actions:
 *
 *   - `generateWeeklyReviewAction(weekStart?)` — build the stats summary,
 *       call the AI (with retries + fallback), store the WeeklyReview row.
 *   - `generateAllWeeklyReviewsAction()` — cron-friendly: generate for all
 *       users with aiReviewEnabled=true.
 *   - `listWeeklyReviewsAction()` — reviews for the Reports page.
 *   - `updateAIReviewSettingsAction(formData)` — the opt-in toggle.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import {
  getAnthropicClient,
  generateWeeklyReviewWithFallback,
  isoWeekRange,
  type WeeklyStatsInput,
} from "@/lib/ai/review";
import { aggregateByHour, bestAndWorstHours } from "@/lib/news/sessions";

export type AIReviewActionResult = {
  ok: boolean;
  message: string;
};

export type WeeklyReviewRow = {
  id: string;
  weekStart: Date;
  weekEnd: Date;
  summary: string;
  suggestions: string[];
  source: "ai" | "fallback";
  metrics: WeeklyStatsInput;
  createdAt: Date;
};

// ─── Stats builder ───────────────────────────────────────────────────────────

/**
 * Build the aggregated weekly stats for a user. Sends ONLY aggregates to
 * the AI — no email, name, or screenshots (verified by a unit test).
 */
async function buildWeeklyStats(
  userId: string,
  weekStart: Date,
  weekEnd: Date,
  userTz: string,
): Promise<WeeklyStatsInput> {
  const [trades, tiltEvents, dailyScores, lockoutOverrides, withdrawals] = await Promise.all([
    db.trade.findMany({
      where: {
        userId,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: weekStart, lt: weekEnd },
      },
      select: {
        openedAt: true,
        profitLoss: true,
        result: true,
        stake: true,
        payoutPercent: true,
        emotion: true,
        strategy: { select: { name: true } },
      },
      take: 2000,
    }),
    db.tiltEvent.count({
      where: { userId, level: "TILT", createdAt: { gte: weekStart, lt: weekEnd } },
    }),
    db.dailyScore.findMany({
      where: { userId, date: { gte: isoDate(weekStart), lt: isoDate(weekEnd) } },
      select: { score: true },
    }),
    db.auditLog.count({
      where: {
        userId,
        action: { in: ["LOCKOUT_OVERRIDDEN"] },
        createdAt: { gte: weekStart, lt: weekEnd },
      },
    }),
    db.transaction.aggregate({
      where: {
        tradingAccount: { userId },
        type: "WITHDRAWAL",
        occurredAt: { gte: weekStart, lt: weekEnd },
      },
      _count: { _all: true },
    }),
  ]);

  const netPL = trades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const wins = trades.filter((t) => t.result === "WIN").length;
  const losses = trades.filter((t) => t.result === "LOSS").length;
  const ties = trades.filter((t) => t.result === "TIE").length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;

  // Profit factor (gross profit / gross loss).
  const grossProfit = trades.reduce(
    (acc, t) => acc + Math.max(0, Number(t.profitLoss.toString())),
    0,
  );
  const grossLoss = trades.reduce(
    (acc, t) => acc + Math.abs(Math.min(0, Number(t.profitLoss.toString()))),
    0,
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  // Best/worst strategy by expectancy.
  const byStrategy = new Map<string, { netPL: number; trades: number }>();
  for (const t of trades) {
    const name = t.strategy?.name ?? "No strategy";
    const b = byStrategy.get(name) ?? { netPL: 0, trades: 0 };
    b.netPL += Number(t.profitLoss.toString());
    b.trades++;
    byStrategy.set(name, b);
  }
  let bestStrategy: WeeklyStatsInput["bestStrategy"] = null;
  let worstStrategy: WeeklyStatsInput["worstStrategy"] = null;
  for (const [name, b] of byStrategy) {
    if (b.trades < 3) continue; // need ≥3 trades to be meaningful
    const exp = b.netPL / b.trades;
    if (!bestStrategy || exp > bestStrategy.expectancyPerTrade) {
      bestStrategy = { name, expectancyPerTrade: Math.round(exp * 100) / 100, trades: b.trades };
    }
    if (!worstStrategy || exp < worstStrategy.expectancyPerTrade) {
      worstStrategy = { name, expectancyPerTrade: Math.round(exp * 100) / 100, trades: b.trades };
    }
  }

  // Best/worst hour (in user TZ).
  const tradesForHours = trades.map((t) => ({
    openedAt: t.openedAt,
    profitLoss: Number(t.profitLoss.toString()),
    result: t.result as "WIN" | "LOSS" | "TIE",
  }));
  const hourly = aggregateByHour(tradesForHours, userTz);
  const { best, worst } = bestAndWorstHours(hourly);

  // Top emotions.
  const byEmotion = new Map<string, number>();
  for (const t of trades) {
    if (!t.emotion) continue;
    byEmotion.set(t.emotion, (byEmotion.get(t.emotion) ?? 0) + 1);
  }
  const topEmotions = [...byEmotion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([emotion, count]) => ({ emotion, count }));

  const avgDisciplineScore =
    dailyScores.length === 0
      ? null
      : dailyScores.reduce((acc, s) => acc + Number(s.score.toString()), 0) / dailyScores.length;

  return {
    weekStart: isoDate(weekStart),
    weekEnd: isoDate(new Date(weekEnd.getTime() - 1)),
    netPL: Math.round(netPL.toNumber() * 100) / 100,
    totalTrades: trades.length,
    wins,
    losses,
    ties,
    winRate: Math.round(winRate * 1000) / 1000,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : Infinity,
    tiltEvents,
    avgDisciplineScore: avgDisciplineScore == null ? null : Math.round(avgDisciplineScore),
    bestStrategy,
    worstStrategy,
    bestHour: best?.hour ?? null,
    worstHour: worst?.hour ?? null,
    topEmotions,
    ruleBreaches: lockoutOverrides,
    withdrewCount: withdrawals._count._all,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── 1. generateWeeklyReviewAction ──────────────────────────────────────────

export async function generateWeeklyReviewAction(
  weekStartIso?: string,
): Promise<AIReviewActionResult & { review?: WeeklyReviewRow }> {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";

  // Check the opt-in toggle.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { aiReviewEnabled: true },
  });
  if (!user?.aiReviewEnabled) {
    return {
      ok: false,
      message: "AI weekly review is disabled. Enable it in Settings first.",
    };
  }

  // Resolve the week (default: the week containing today).
  const base = weekStartIso ? new Date(weekStartIso) : new Date();
  const { start: weekStart, end: weekEnd } = isoWeekRange(base);

  // Build the aggregated stats.
  const stats = await buildWeeklyStats(userId, weekStart, weekEnd, tz);

  // Call the AI with retries + fallback.
  const client = getAnthropicClient();
  const review = await generateWeeklyReviewWithFallback(stats, client);

  // Store (upsert — one row per user per week).
  const row = await db.weeklyReview.upsert({
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
      weekEnd,
      summary: review.summary,
      suggestions: JSON.parse(JSON.stringify(review.suggestions)),
      source: review.source,
      metrics: JSON.parse(JSON.stringify(stats)),
    },
  });

  // Audit log.
  await db.auditLog.create({
    data: {
      userId,
      action: "WEEKLY_REVIEW_GENERATED",
      entity: "WeeklyReview",
      entityId: row.id,
      meta: { weekStart: isoDate(weekStart), source: review.source },
    },
  });

  revalidatePath("/app/reports");
  return {
    ok: true,
    message: `Weekly review generated (${review.source}).`,
    review: {
      id: row.id,
      weekStart,
      weekEnd,
      summary: review.summary,
      suggestions: review.suggestions,
      source: review.source,
      metrics: stats,
      createdAt: row.createdAt,
    },
  };
}

// ─── 2. generateAllWeeklyReviewsAction ──────────────────────────────────────

/**
 * Cron-friendly: generate the weekly review for every user with
 * aiReviewEnabled=true. Uses the PREVIOUS completed week (not the current
 * partial week).
 */
export async function generateAllWeeklyReviewsAction(): Promise<
  AIReviewActionResult & { generatedCount?: number; scannedCount?: number }
> {
  const users = await db.user.findMany({
    where: { isOnboarded: true, aiReviewEnabled: true },
    select: { id: true, timezone: true },
  });

  // Previous completed week: the week containing "7 days ago".
  const prevWeekDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { start: weekStart, end: weekEnd } = isoWeekRange(prevWeekDate);

  let generated = 0;
  for (const user of users) {
    try {
      // Check if a review already exists for this week — skip if so.
      const existing = await db.weeklyReview.findUnique({
        where: { userId_weekStart: { userId: user.id, weekStart } },
        select: { id: true },
      });
      if (existing) continue;

      const stats = await buildWeeklyStats(user.id, weekStart, weekEnd, user.timezone || "UTC");
      const client = getAnthropicClient();
      const review = await generateWeeklyReviewWithFallback(stats, client);
      await db.weeklyReview.upsert({
        where: { userId_weekStart: { userId: user.id, weekStart } },
        create: {
          userId: user.id,
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
          metrics: JSON.parse(JSON.stringify(stats)),
        },
      });
      generated++;
    } catch {
      // Per-user failure — skip + continue.
    }
  }

  return {
    ok: true,
    message: `Weekly review sweep: ${generated} generated of ${users.length} opted-in users.`,
    generatedCount: generated,
    scannedCount: users.length,
  };
}

// ─── 3. listWeeklyReviewsAction ──────────────────────────────────────────────

export async function listWeeklyReviewsAction(): Promise<
  AIReviewActionResult & { reviews?: WeeklyReviewRow[] }
> {
  const { userId } = await requireUser();
  const rows = await db.weeklyReview.findMany({
    where: { userId },
    orderBy: { weekStart: "desc" },
    take: 12,
  });
  return {
    ok: true,
    message: `${rows.length} review${rows.length === 1 ? "" : "s"}.`,
    reviews: rows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      summary: r.summary,
      suggestions: r.suggestions as string[],
      source: r.source as "ai" | "fallback",
      metrics: r.metrics as WeeklyStatsInput,
      createdAt: r.createdAt,
    })),
  };
}

// ─── 4. updateAIReviewSettingsAction ────────────────────────────────────────

export async function updateAIReviewSettingsAction(
  formData: FormData,
): Promise<AIReviewActionResult> {
  const { userId } = await requireUser();
  const enabled = formData.get("aiReviewEnabled") === "true";
  await db.user.update({
    where: { id: userId },
    data: { aiReviewEnabled: enabled },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "AI_REVIEW_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: { enabled },
    },
  });
  revalidatePath("/app/settings");
  revalidatePath("/app/reports");
  return {
    ok: true,
    message: enabled
      ? "AI weekly review enabled. Only aggregated stats are shared — never your email, name, or screenshots."
      : "AI weekly review disabled.",
  };
}

// Keep the fallback contract documented: when the AI fails, the
// rule-based `buildFallbackReview` (in @/lib/ai/review) generates the
// review deterministically — mirroring the Phase 9 insights approach.
// No direct import needed here (the orchestrator owns the fallback).
