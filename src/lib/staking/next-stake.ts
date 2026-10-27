/**
 * Phase 8 — "Next stake" suggestion helper.
 *
 * Used by the Add Trade form (Phase 5) to show a suggested stake next to
 * the stake input field. The suggestion:
 *   1. Picks the user's default staking plan from the DB (StakingPlan
 *      where isDefault=true).
 *   2. Fetches the active account's recent closed trades (last 20) to
 *      build the StakingContext (consecutive losses, wins, etc.).
 *   3. Calls the plan's computeNextStake().
 *   4. Clamps to the Risk Rules limit (riskPerTradePercent × balance)
 *      so the suggestion never exceeds the user's per-trade risk cap.
 *
 * Server-side: uses db. Returns the suggested stake as a string + the plan
 * name + whether it was clamped (for the UI to show a warning).
 */
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { computeNextStake } from "./plans";
import type { PlanConfig, StakingContext, TradeOutcome } from "./types";
import type { StakingMethod } from "@prisma/client";

export type NextStakeSuggestion = {
  suggestedStake: string; // Decimal-precise string
  planName: string;
  planMethod: StakingMethod;
  clamped: boolean; // true if the suggestion was capped by the Risk Rules limit
  riskLimit: string; // the Risk Rules per-trade limit (for UI display)
  originalSuggestion: string; // pre-clamp value (for UI diff display)
};

/**
 * Parse a StakingPlan's `config` JSON field into a typed PlanConfig.
 * Defensive: returns null if the shape is unrecognized.
 */
export function parsePlanConfig(raw: unknown): PlanConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.method !== "string") return null;
  // Trust the DB shape — Zod validation on save guarantees the fields exist.
  return c as unknown as PlanConfig;
}

/**
 * Compute the next-stake suggestion for the given account + user.
 *
 * Returns null if the user has no default staking plan, or no recent
 * trades, or no RiskProfile (in which case the UI shows no suggestion).
 */
export async function getNextStakeSuggestion(
  userId: string,
  tradingAccountId: string,
): Promise<NextStakeSuggestion | null> {
  // 1. Get user's default staking plan.
  const defaultPlan = await db.stakingPlan.findFirst({
    where: { userId, isDefault: true },
  });
  if (!defaultPlan) {
    // Fall back to any plan if no default.
    const anyPlan = await db.stakingPlan.findFirst({ where: { userId } });
    if (!anyPlan) return null;
    return computeSuggestionFromPlan(
      anyPlan.id,
      anyPlan.name,
      anyPlan.method,
      anyPlan.config,
      userId,
      tradingAccountId,
    );
  }
  return computeSuggestionFromPlan(
    defaultPlan.id,
    defaultPlan.name,
    defaultPlan.method,
    defaultPlan.config,
    userId,
    tradingAccountId,
  );
}

async function computeSuggestionFromPlan(
  planId: string,
  planName: string,
  _method: StakingMethod,
  rawConfig: unknown,
  userId: string,
  tradingAccountId: string,
): Promise<NextStakeSuggestion | null> {
  const config = parsePlanConfig(rawConfig);
  if (!config) return null;

  // 2. Get the active account balance + recent trades.
  const account = await db.tradingAccount.findFirst({
    where: { id: tradingAccountId, userId },
    select: { currentBalance: true, currency: true },
  });
  if (!account) return null;

  const recentTrades = await db.trade.findMany({
    where: {
      userId,
      tradingAccountId,
      result: { in: ["WIN", "LOSS", "TIE"] },
    },
    orderBy: { closedAt: "desc" },
    take: 20,
    select: { result: true, payoutPercent: true, stake: true },
  });

  // 3. Build the StakingContext.
  let consecutiveLosses = 0;
  let consecutiveWins = 0;
  for (const t of recentTrades) {
    if (t.result === "LOSS") {
      consecutiveLosses++;
      consecutiveWins = 0;
    } else if (t.result === "WIN") {
      consecutiveWins++;
      consecutiveLosses = 0;
    } else break; // TIE resets — stop counting
  }

  // Use the average payout from recent trades, or fall back to 0.85.
  const avgPayout =
    recentTrades.length > 0
      ? recentTrades.reduce((acc, t) => acc + Number(t.payoutPercent.toString()), 0) /
        recentTrades.length
      : 0.85;
  // Estimate win-rate from recent trades.
  const winRate =
    recentTrades.length > 0
      ? recentTrades.filter((t) => t.result === "WIN").length / recentTrades.length
      : 0.55;

  const ctx: StakingContext = {
    balance: Number(account.currentBalance.toString()),
    recentResults: recentTrades.reverse().map((t) => t.result as TradeOutcome),
    consecutiveLosses,
    consecutiveWins,
    tradeNumber: recentTrades.length + 1,
    payoutPercent: avgPayout,
    winRate,
  };

  // 4. Compute the next stake using the plan.
  const suggestedStakeRaw = computeNextStake(ctx, config);
  if (suggestedStakeRaw <= 0) return null;

  // 5. Clamp to Risk Rules limit (riskPerTradePercent × balance).
  const profile =
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId },
    })) ??
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: null },
      orderBy: { createdAt: "desc" },
    }));
  const riskPerTradePct = profile ? Number(profile.riskPerTradePercent.toString()) : 2; // default 2%
  const balance = Number(account.currentBalance.toString());
  const riskLimit = balance * (riskPerTradePct / 100);

  const suggestedStakeDecimal = new Decimal(suggestedStakeRaw).toDecimalPlaces(2);
  const riskLimitDecimal = new Decimal(riskLimit).toDecimalPlaces(2);

  const clamped = suggestedStakeDecimal.gt(riskLimitDecimal);
  const finalStake = clamped ? riskLimitDecimal : suggestedStakeDecimal;

  return {
    suggestedStake: finalStake.toString(),
    planName,
    planMethod: _method,
    clamped,
    riskLimit: riskLimitDecimal.toString(),
    originalSuggestion: suggestedStakeDecimal.toString(),
  };
}
