"use server";

/**
 * Phase 22 — Market-session + hourly analysis server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #2:
 * pure calc lives in /src/lib/news/sessions.ts. rule #11: visible risk
 * disclaimer — the analysis is descriptive, not predictive.)
 *
 * Three actions:
 *
 *   - `getSessionAnalysisAction(opts?)` — per-session win rate / P/L /
 *     expectancy. Optionally filter by account + date range.
 *
 *   - `getHourlyAnalysisAction(opts?)` — per-hour (in user TZ) win rate /
 *     P/L / expectancy. Highlights best + worst hours. Used by the
 *     Sessions page heatmap + the "suggest trading hours" CTA.
 *
 *   - `suggestTradingHoursAction()` — pure suggestion based on the user's
 *     last 90 days of trades. Returns a { start, end, days } object that
 *     the UI can use to fill the Phase 12 TradingHoursForm.
 */
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import type { TradeResult } from "@prisma/client";
import {
  aggregateBySession,
  aggregateByHour,
  bestAndWorstHours,
  suggestTradingHours,
  type SessionStat,
  type HourStat,
} from "@/lib/news/sessions";

export type SessionsActionResult = {
  ok: boolean;
  message: string;
};

export type SessionAnalysisResult = SessionsActionResult & {
  sessions?: SessionStat[];
  totalTrades?: number;
};

export type HourlyAnalysisResult = SessionsActionResult & {
  hours?: HourStat[];
  bestHour?: HourStat | null;
  worstHour?: HourStat | null;
  suggestedTradingHours?: { start: string; end: string; days: number[] } | null;
  totalTrades?: number;
};

// ─── 1. getSessionAnalysisAction ────────────────────────────────────────────

export async function getSessionAnalysisAction(input?: {
  tradingAccountId?: string;
  fromIso?: string;
  toIso?: string;
}): Promise<SessionAnalysisResult> {
  const { userId } = await requireUser();
  const trades = await db.trade.findMany({
    where: {
      userId,
      ...(input?.tradingAccountId ? { tradingAccountId: input.tradingAccountId } : {}),
      result: { in: ["WIN", "LOSS", "TIE"] as TradeResult[] },
      ...(input?.fromIso || input?.toIso
        ? {
            openedAt: {
              ...(input?.fromIso ? { gte: new Date(input.fromIso) } : {}),
              ...(input?.toIso ? { lte: new Date(input.toIso) } : {}),
            },
          }
        : {}),
    },
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      openedAt: true,
      profitLoss: true,
      result: true,
    },
    take: 5000,
  });

  const tradesForCalc = trades.map((t) => ({
    openedAt: t.openedAt,
    profitLoss: Number(t.profitLoss.toString()),
    result: t.result as "WIN" | "LOSS" | "TIE",
  }));
  const sessions = aggregateBySession(tradesForCalc);
  return {
    ok: true,
    message: `${trades.length} trades analyzed across ${sessions.length} sessions.`,
    sessions,
    totalTrades: trades.length,
  };
}

// ─── 2. getHourlyAnalysisAction ─────────────────────────────────────────────

export async function getHourlyAnalysisAction(input?: {
  tradingAccountId?: string;
  fromIso?: string;
  toIso?: string;
}): Promise<HourlyAnalysisResult> {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";
  const trades = await db.trade.findMany({
    where: {
      userId,
      ...(input?.tradingAccountId ? { tradingAccountId: input.tradingAccountId } : {}),
      result: { in: ["WIN", "LOSS", "TIE"] as TradeResult[] },
      ...(input?.fromIso || input?.toIso
        ? {
            openedAt: {
              ...(input?.fromIso ? { gte: new Date(input.fromIso) } : {}),
              ...(input?.toIso ? { lte: new Date(input.toIso) } : {}),
            },
          }
        : {}),
    },
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      openedAt: true,
      profitLoss: true,
      result: true,
    },
    take: 5000,
  });

  const tradesForCalc = trades.map((t) => ({
    openedAt: t.openedAt,
    profitLoss: Number(t.profitLoss.toString()),
    result: t.result as "WIN" | "LOSS" | "TIE",
  }));
  const hours = aggregateByHour(tradesForCalc, tz);
  const { best, worst } = bestAndWorstHours(hours);
  const suggestion = suggestTradingHours(hours);
  return {
    ok: true,
    message: `${trades.length} trades analyzed across 24 hours (${tz}).`,
    hours,
    bestHour: best,
    worstHour: worst,
    suggestedTradingHours: suggestion,
    totalTrades: trades.length,
  };
}

// ─── 3. suggestTradingHoursAction ────────────────────────────────────────────

/**
 * Standalone suggestion action — calls getHourlyAnalysisAction internally
 * and returns just the suggested trading hours. The Sessions page's
 * "Suggest trading hours" button calls this.
 */
export async function suggestTradingHoursAction(): Promise<
  SessionsActionResult & {
    suggestion?: { start: string; end: string; days: number[] } | null;
  }
> {
  const r = await getHourlyAnalysisAction();
  return {
    ok: r.ok,
    message:
      r.suggestedTradingHours == null
        ? "Not enough qualifying trades to suggest trading hours (need ≥3 trades/hour in at least one profitable hour)."
        : `Suggested window: ${r.suggestedTradingHours.start}–${r.suggestedTradingHours.end} Mon–Fri.`,
    suggestion: r.suggestedTradingHours,
  };
}
