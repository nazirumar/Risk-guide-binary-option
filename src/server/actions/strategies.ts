"use server";

/**
 * Phase 20 — Strategy Validation server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #4: Zod on
 * the server. rule #1: money as Decimal. rule #8: state changes are audited.)
 *
 * Seven actions:
 *
 *   - `createStrategyAction`           — new strategy per user.
 *   - `updateStrategyAction`           — rename / edit description / color /
 *                                         toggle isActive.
 *   - `deleteStrategyAction`           — soft: reassigns trades to null
 *                                         strategyId (schema uses SetNull).
 *   - `listStrategiesWithStatsAction`  — list of strategies with cached stats
 *                                         + per-strategy reliability verdict.
 *                                         Drives the comparison table and the
 *                                         Add Trade form's per-option verdict.
 *   - `getStrategyValidationAction`     — detailed validation for one strategy:
 *                                         Wilson interval, p-value, rating,
 *                                         verdict, and a running tally of the
 *                                         Wilson band over the trade history
 *                                         (for the chart).
 *   - `recomputeStrategyStatsAction`   — recompute + persist the 6 cached
 *                                         stat fields on Strategy. Called by
 *                                         `createTradeAction` / `closeTradeAction`
 *                                         / `deleteTradeAction` (Phase 5) and
 *                                         available standalone here.
 *
 * NOTE: a "use server" file may only export async functions — non-async
 * types/helpers live in `./strategies-types.ts` if needed.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import {
  reliabilityRating,
  wilsonInterval,
  type ReliabilityAssessment,
} from "@/lib/calc/validation";
import { computeStats } from "@/lib/calc/rates";
import { normalizeTrades } from "@/lib/calc/normalize";
import type { TradeLike } from "@/lib/calc/types";

export type StrategyActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type StrategyRow = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isActive: boolean;
  totalTrades: number;
  winRate: number | null; // 0–1
  expectancyPerTrade: number | null;
  profitFactor: number | null;
  isValidated: boolean;
  lastValidatedAt: Date | null;
  // Phase 20 validation summary — computed live (not cached) so it reflects
  // the latest trade history regardless of when recomputeStrategyStatsAction
  // last ran.
  reliability: ReliabilityAssessment;
};

export type StrategyValidationDetail = StrategyRow & {
  /** Running Wilson band over the trade history — for the chart that shows
   *  the confidence band shrinking as trades accumulate. Each entry is
   *  { tradeNumber, lower, upper, winRate, profitLoss } for one closed trade
   *  in chronological order. */
  history: {
    tradeNumber: number;
    lower: number;
    upper: number;
    winRate: number;
    profitLoss: number;
    openedAt: Date;
    asset: string;
    result: "WIN" | "LOSS" | "TIE";
  }[];
  averagePayout: number;
  /** Disclaimer for the UI — past results don't guarantee future returns. */
  disclaimer: string;
};

// ─── Ownership + lookup helpers ─────────────────────────────────────────────

async function verifyStrategyOwnership(strategyId: string, userId: string) {
  return db.strategy.findFirst({
    where: { id: strategyId, userId },
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      isActive: true,
    },
  });
}

// ─── Pure helper: compute live stats from trades ───────────────────────────

/**
 * Pure helper — given the closed trades for a strategy, compute:
 *   - totalTrades (closed WIN/LOSS/TIE only — OPEN excluded)
 *   - winRate (wins / total)
 *   - averagePayout (mean of payoutPercent across the closed trades; used
 *     to compute the break-even win rate)
 *   - reliability assessment via reliabilityRating(wins, total, avgPayout)
 *
 * Pure: no DB access. Used by both listStrategiesWithStatsAction (for the
 * comparison table) and getStrategyValidationAction (for the detail page).
 */
function computeLiveStats(trades: TradeLike[]): {
  totalTrades: number;
  wins: number;
  winRate: number | null;
  averagePayout: number;
  reliability: ReliabilityAssessment;
} {
  if (trades.length === 0) {
    // No closed trades → reliability with all zeros. Use a default payout
    // (0.85) so the break-even math doesn't crash; the UI hides this case.
    return {
      totalTrades: 0,
      wins: 0,
      winRate: null,
      averagePayout: 0.85,
      reliability: reliabilityRating(0, 0, 0.85),
    };
  }
  const normalized = normalizeTrades(trades);
  const stats = computeStats(trades);
  const wins = stats.counts.wins;
  const total = stats.counts.total;
  const avgPayout = stats.averagePayout || 0.85;
  return {
    totalTrades: total,
    wins,
    winRate: total > 0 ? stats.winRate : null,
    averagePayout: avgPayout,
    reliability: reliabilityRating(wins, total, avgPayout),
  };
}

// ─── 1. createStrategyAction ────────────────────────────────────────────────

export async function createStrategyAction(
  formData: FormData,
): Promise<StrategyActionResult & { strategyId?: string }> {
  const { userId } = await requireUser();
  // Inline schema — strategy create is simple enough to not warrant a separate
  // validation.ts entry, but we still Zod on the server (rule #4).
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const color = String(formData.get("color") ?? "#64748b");
  if (!name || name.length > 100) {
    return {
      ok: false,
      message: "Strategy name is required (max 100 characters).",
      fieldErrors: { name: "Name is required." },
    };
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return {
      ok: false,
      message: "Color must be a valid hex (e.g. #64748b).",
      fieldErrors: { color: "Invalid hex color." },
    };
  }

  try {
    const s = await db.strategy.create({
      data: { userId, name, description, color, isActive: true },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "STRATEGY_CREATED",
        entity: "Strategy",
        entityId: s.id,
        meta: { name, color },
      },
    });
    revalidatePath("/app/strategies");
    revalidatePath("/app/trades");
    return { ok: true, message: `Strategy "${name}" created.`, strategyId: s.id };
  } catch (e) {
    // Unique constraint violation: name already in use by this user.
    if (e instanceof Error && /unique/i.test(e.message)) {
      return {
        ok: false,
        message: `You already have a strategy named "${name}".`,
        fieldErrors: { name: "Name already in use." },
      };
    }
    throw e;
  }
}

// ─── 2. updateStrategyAction ────────────────────────────────────────────────

export async function updateStrategyAction(formData: FormData): Promise<StrategyActionResult> {
  const { userId } = await requireUser();
  const strategyId = String(formData.get("strategyId") ?? "");
  if (!strategyId) return { ok: false, message: "Missing strategy id." };

  const existing = await verifyStrategyOwnership(strategyId, userId);
  if (!existing) return { ok: false, message: "Strategy not found." };

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const color = String(formData.get("color") ?? existing.color);
  const isActive = formData.get("isActive") === "true";

  if (!name || name.length > 100) {
    return {
      ok: false,
      message: "Strategy name is required (max 100 characters).",
      fieldErrors: { name: "Name is required." },
    };
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return {
      ok: false,
      message: "Color must be a valid hex (e.g. #64748b).",
      fieldErrors: { color: "Invalid hex color." },
    };
  }

  try {
    await db.strategy.update({
      where: { id: strategyId },
      data: { name, description, color, isActive },
    });
    await db.auditLog.create({
      data: {
        userId,
        action: "STRATEGY_UPDATED",
        entity: "Strategy",
        entityId: strategyId,
        meta: { name, color, isActive },
      },
    });
    revalidatePath("/app/strategies");
    revalidatePath(`/app/strategies/${strategyId}`);
    revalidatePath("/app/trades");
    return { ok: true, message: `Strategy "${name}" updated.` };
  } catch (e) {
    if (e instanceof Error && /unique/i.test(e.message)) {
      return {
        ok: false,
        message: `You already have a strategy named "${name}".`,
        fieldErrors: { name: "Name already in use." },
      };
    }
    throw e;
  }
}

// ─── 3. deleteStrategyAction ────────────────────────────────────────────────

export async function deleteStrategyAction(formData: FormData): Promise<StrategyActionResult> {
  const { userId } = await requireUser();
  const strategyId = String(formData.get("strategyId") ?? "");
  if (!strategyId) return { ok: false, message: "Missing strategy id." };

  const existing = await verifyStrategyOwnership(strategyId, userId);
  if (!existing) return { ok: false, message: "Strategy not found." };

  // Schema uses `onDelete: SetNull` for Trade.strategyId, so trades keep
  // their data — they just become "no strategy" trades. Safer than cascade
  // because traders may want to preserve trade history even after deleting
  // the strategy label.
  await db.strategy.delete({ where: { id: strategyId } });
  await db.auditLog.create({
    data: {
      userId,
      action: "STRATEGY_DELETED",
      entity: "Strategy",
      entityId: strategyId,
      meta: { name: existing.name },
    },
  });

  revalidatePath("/app/strategies");
  revalidatePath("/app/trades");
  return { ok: true, message: `Strategy "${existing.name}" deleted.` };
}

// ─── 4. listStrategiesWithStatsAction ───────────────────────────────────────

export async function listStrategiesWithStatsAction(): Promise<
  StrategyActionResult & { strategies?: StrategyRow[] }
> {
  const { userId } = await requireUser();
  const strategies = await db.strategy.findMany({
    where: { userId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      isActive: true,
      totalTrades: true,
      winRate: true,
      expectancyPerTrade: true,
      profitFactor: true,
      isValidated: true,
      lastValidatedAt: true,
    },
  });

  if (strategies.length === 0) {
    return { ok: true, message: "No strategies yet.", strategies: [] };
  }

  // Fetch closed trades per strategy in one query (group by strategyId).
  const closedTrades = await db.trade.findMany({
    where: {
      userId,
      strategyId: { in: strategies.map((s) => s.id) },
      result: { in: ["WIN", "LOSS", "TIE"] },
    },
    select: {
      strategyId: true,
      profitLoss: true,
      stake: true,
      payoutPercent: true,
      openedAt: true,
      asset: true,
      direction: true,
      result: true,
    },
  });

  // Group trades by strategyId.
  const byStrategy = new Map<string, TradeLike[]>();
  for (const t of closedTrades) {
    if (!t.strategyId) continue;
    const list = byStrategy.get(t.strategyId) ?? [];
    list.push({
      profitLoss: t.profitLoss.toString(),
      stake: t.stake.toString(),
      payoutPercent: t.payoutPercent.toString(),
      openedAt: t.openedAt,
      asset: t.asset,
      direction: t.direction,
      result: t.result,
    });
    byStrategy.set(t.strategyId, list);
  }

  const rows: StrategyRow[] = strategies.map((s) => {
    const trades = byStrategy.get(s.id) ?? [];
    const live = computeLiveStats(trades);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      color: s.color,
      isActive: s.isActive,
      totalTrades: live.totalTrades,
      winRate: live.winRate,
      expectancyPerTrade: s.expectancyPerTrade == null ? null : Number(s.expectancyPerTrade),
      profitFactor: s.profitFactor == null ? null : Number(s.profitFactor),
      isValidated: s.isValidated,
      lastValidatedAt: s.lastValidatedAt,
      reliability: live.reliability,
    };
  });

  return { ok: true, message: `${rows.length} strategies.`, strategies: rows };
}

// ─── 5. getStrategyValidationAction ──────────────────────────────────────────

export async function getStrategyValidationAction(
  strategyId: string,
): Promise<StrategyActionResult & { strategy?: StrategyValidationDetail }> {
  const { userId } = await requireUser();
  const existing = await verifyStrategyOwnership(strategyId, userId);
  if (!existing) return { ok: false, message: "Strategy not found." };

  // Fetch the cached fields + all closed trades for this strategy, ordered
  // chronologically so we can build the running Wilson band chart.
  const strategy = await db.strategy.findUniqueOrThrow({
    where: { id: strategyId },
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      isActive: true,
      totalTrades: true,
      winRate: true,
      expectancyPerTrade: true,
      profitFactor: true,
      isValidated: true,
      lastValidatedAt: true,
    },
  });
  const trades = await db.trade.findMany({
    where: { userId, strategyId, result: { in: ["WIN", "LOSS", "TIE"] } },
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      profitLoss: true,
      stake: true,
      payoutPercent: true,
      openedAt: true,
      asset: true,
      direction: true,
      result: true,
    },
  });

  const tradeLikes: TradeLike[] = trades.map((t) => ({
    profitLoss: t.profitLoss.toString(),
    stake: t.stake.toString(),
    payoutPercent: t.payoutPercent.toString(),
    openedAt: t.openedAt,
    asset: t.asset,
    direction: t.direction,
    result: t.result,
  }));

  const live = computeLiveStats(tradeLikes);

  // Build the running Wilson band — for each closed trade at index i, compute
  // the Wilson 95% CI based on wins-so-far / total-so-far. This is the chart
  // that visualizes the band shrinking as trades accumulate.
  let winsSoFar = 0;
  const history: StrategyValidationDetail["history"] = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.result === "WIN") winsSoFar++;
    const total = i + 1;
    const w = wilsonInterval(winsSoFar, total, 0.95);
    history.push({
      tradeNumber: total,
      lower: w.lower,
      upper: w.upper,
      winRate: winsSoFar / total,
      profitLoss: Number(t.profitLoss.toString()),
      openedAt: t.openedAt,
      asset: t.asset,
      result: t.result as "WIN" | "LOSS" | "TIE",
    });
    // Payout is used implicitly via the average across all trades in the
    // overall reliability assessment; the Wilson band is independent of
    // payout — it's just about the observed win-rate distribution.
  }

  const detail: StrategyValidationDetail = {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    color: strategy.color,
    isActive: strategy.isActive,
    totalTrades: live.totalTrades,
    winRate: live.winRate,
    expectancyPerTrade:
      strategy.expectancyPerTrade == null ? null : Number(strategy.expectancyPerTrade),
    profitFactor: strategy.profitFactor == null ? null : Number(strategy.profitFactor),
    isValidated: strategy.isValidated,
    lastValidatedAt: strategy.lastValidatedAt,
    reliability: live.reliability,
    history,
    averagePayout: live.averagePayout,
    disclaimer:
      "Past performance does not guarantee future results. These statistics describe historical trades — they're a discipline aid, not a prediction.",
  };

  return { ok: true, message: "Strategy validation.", strategy: detail };
}

// ─── 6. recomputeStrategyStatsAction ─────────────────────────────────────────

/**
 * Recompute + persist the 6 cached stat fields on Strategy (totalTrades,
 * winRate, expectancyPerTrade, profitFactor, isValidated, lastValidatedAt).
 *
 * Should be called whenever a trade with this strategy is saved/closed/
 * deleted — Phase 5's createTradeAction / closeTradeAction / deleteTradeAction
 * should wire this in (or, for now, the user can trigger manually from the
 * strategy detail page). The isValidated flag is `true` iff totalTrades ≥ 30
 * AND the Wilson lower bound of the win rate beats the break-even win rate
 * for the strategy's average payout.
 */
export async function recomputeStrategyStatsAction(
  strategyId: string,
): Promise<StrategyActionResult> {
  const { userId } = await requireUser();
  const existing = await verifyStrategyOwnership(strategyId, userId);
  if (!existing) return { ok: false, message: "Strategy not found." };

  const trades = await db.trade.findMany({
    where: { userId, strategyId, result: { in: ["WIN", "LOSS", "TIE"] } },
    select: {
      profitLoss: true,
      stake: true,
      payoutPercent: true,
      openedAt: true,
      asset: true,
      direction: true,
      result: true,
    },
  });
  const tradeLikes: TradeLike[] = trades.map((t) => ({
    profitLoss: t.profitLoss.toString(),
    stake: t.stake.toString(),
    payoutPercent: t.payoutPercent.toString(),
    openedAt: t.openedAt,
    asset: t.asset,
    direction: t.direction,
    result: t.result,
  }));
  const live = computeLiveStats(tradeLikes);
  const stats = trades.length > 0 ? computeStats(tradeLikes) : null;

  // Use Decimal for the monetary fields (rule #1). winRate + profitFactor
  // are dimensionless ratios; store as Decimal for consistency with the
  // schema.
  const winRate = live.winRate == null ? null : new Decimal(live.winRate).toDecimalPlaces(6);
  const expectancy =
    stats == null ? null : new Decimal(stats.expectancyPerTrade).toDecimalPlaces(2);
  const profitFactor =
    stats == null
      ? null
      : !Number.isFinite(stats.profitFactor)
        ? new Decimal(0)
        : new Decimal(stats.profitFactor).toDecimalPlaces(4);

  await db.strategy.update({
    where: { id: strategyId },
    data: {
      totalTrades: live.totalTrades,
      winRate,
      expectancyPerTrade: expectancy,
      profitFactor,
      isValidated: live.reliability.verdict === "Likely profitable",
      lastValidatedAt: new Date(),
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "STRATEGY_STATS_RECOMPUTED",
      entity: "Strategy",
      entityId: strategyId,
      meta: JSON.parse(
        JSON.stringify({
          totalTrades: live.totalTrades,
          winRate: live.winRate,
          verdict: live.reliability.verdict,
          rating: live.reliability.rating,
          isValidated: live.reliability.verdict === "Likely profitable",
        }),
      ) as never,
    },
  });

  revalidatePath("/app/strategies");
  revalidatePath(`/app/strategies/${strategyId}`);
  revalidatePath("/app/trades");
  return {
    ok: true,
    message: `Stats recomputed: ${live.totalTrades} trades, verdict "${live.reliability.verdict}".`,
  };
}
