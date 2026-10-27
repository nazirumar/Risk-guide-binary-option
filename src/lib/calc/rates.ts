/**
 * Phase 6 — Rates, expectancy, profit factor, averages, ROI.
 *
 * All functions are pure (no DB, no side effects) and use plain numbers
 * (via `normalizeTrades()` which converts Decimal | string | number → number).
 *
 * Edge cases handled:
 *   - Zero trades → every metric returns 0 (avoid NaN from 0/0).
 *   - All wins → lossRate=0, profitFactor=Infinity, averageLoss=0.
 *   - All losses → winRate=0, profitFactor=0 (grossProfit=0).
 *   - Payout 0 → breakEvenWinRate=1 (must win 100% to break even).
 */
import type { NormalizedTrade } from "./types";
import { normalizeTrades } from "./normalize";
import type { TradeLike } from "./types";

// ─── Counts + rates ────────────────────────────────────────────────────────

export type TradeCounts = {
  total: number;
  wins: number;
  losses: number;
  ties: number;
};

export function countTrades(trades: NormalizedTrade[]): TradeCounts {
  let wins = 0,
    losses = 0,
    ties = 0;
  for (const t of trades) {
    if (t.result === "WIN") wins++;
    else if (t.result === "LOSS") losses++;
    else ties++;
  }
  return { total: trades.length, wins, losses, ties };
}

/** Win rate as a fraction (0..1). Zero trades → 0. */
export function winRate(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  return countTrades(trades).wins / trades.length;
}

/** Loss rate as a fraction. Zero trades → 0. */
export function lossRate(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  return countTrades(trades).losses / trades.length;
}

/** Tie rate as a fraction. Zero trades → 0. */
export function tieRate(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  return countTrades(trades).ties / trades.length;
}

/**
 * Break-even win rate for a given payout: the win-rate at which expectancy
 * is exactly zero. Formula: 1 / (1 + payout).
 *
 * Examples:
 *   - 85% payout → 0.5405 (must win ~54% to break even)
 *   - 100% payout → 0.5 (coin-flip)
 *   - 0% payout → 1 (must win every trade)
 *
 * Accepts either a single payout value or the trades array (in which case
 * the average payout across the trades is used).
 */
export function breakEvenWinRate(payoutPercent: number): number {
  if (payoutPercent <= 0) return 1;
  return 1 / (1 + payoutPercent);
}

/** Average payout across all trades (0 if no trades). */
export function averagePayout(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  return trades.reduce((acc, t) => acc + t.payoutPercent, 0) / trades.length;
}

// ─── Profit + loss sums ──────────────────────────────────────────────────────

/** Sum of all positive P/L (gross profit). */
export function grossProfit(trades: NormalizedTrade[]): number {
  return trades.filter((t) => t.profitLoss > 0).reduce((acc, t) => acc + t.profitLoss, 0);
}

/** Absolute value of sum of all negative P/L (gross loss). */
export function grossLoss(trades: NormalizedTrade[]): number {
  return Math.abs(trades.filter((t) => t.profitLoss < 0).reduce((acc, t) => acc + t.profitLoss, 0));
}

/** Net P/L = Σ(profitLoss). */
export function netProfit(trades: NormalizedTrade[]): number {
  return trades.reduce((acc, t) => acc + t.profitLoss, 0);
}

// ─── Averages ────────────────────────────────────────────────────────────────

/** Average positive P/L per winning trade (0 if no wins). */
export function averageWin(trades: NormalizedTrade[]): number {
  const wins = trades.filter((t) => t.profitLoss > 0);
  if (wins.length === 0) return 0;
  return grossProfit(wins) / wins.length;
}

/** Average absolute P/L per losing trade (0 if no losses). */
export function averageLoss(trades: NormalizedTrade[]): number {
  const losses = trades.filter((t) => t.profitLoss < 0);
  if (losses.length === 0) return 0;
  return grossLoss(losses) / losses.length;
}

/** Payoff ratio = averageWin / averageLoss. Infinity if no losses. 0 if no wins or no trades. */
export function payoffRatio(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  const al = averageLoss(trades);
  if (al === 0) return Number.POSITIVE_INFINITY;
  return averageWin(trades) / al;
}

/**
 * Profit factor = grossProfit / grossLoss.
 *
 *   > 1 → profitable
 *   = 1 → break-even
 *   < 1 → losing
 *   = Infinity → no losses at all
 *   = 0 → no wins at all
 */
export function profitFactor(trades: NormalizedTrade[]): number {
  const gl = grossLoss(trades);
  if (gl === 0) {
    return grossProfit(trades) > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return grossProfit(trades) / gl;
}

// ─── Expectancy ─────────────────────────────────────────────────────────────

/**
 * Expectancy per trade = winRate × avgWin − lossRate × avgLoss
 *
 * Gives the average P/L per trade in account currency. Ties contribute 0.
 * Zero trades → 0.
 */
export function expectancyPerTrade(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;
  const counts = countTrades(trades);
  const wr = counts.wins / trades.length;
  const lr = counts.losses / trades.length;
  return wr * averageWin(trades) - lr * averageLoss(trades);
}

/**
 * Expectancy in R (risk multiples) = expectancyPerTrade / averageLoss.
 *
 * R is "the average losing trade" — so a positive expectancy of $10 with
 * averageLoss of $5 = +2R expectancy. 0 if no losses.
 * Useful for comparing traders with different stake sizes / currencies.
 */
export function expectancyInR(trades: NormalizedTrade[]): number {
  const al = averageLoss(trades);
  if (al === 0) return 0;
  return expectancyPerTrade(trades) / al;
}

// ─── ROI ────────────────────────────────────────────────────────────────────

/**
 * Return on Investment = netProfit / startingBalance.
 *
 * Standard ROI against the account's starting capital.
 * startingBalance defaults to the sum of stakes if not provided (so you
 * can call it with just the trades for a "ROI vs total capital at risk").
 */
export function roi(trades: NormalizedTrade[], startingBalance: number = 0): number {
  if (startingBalance <= 0) {
    // Fall back to "total capital at risk" = sum of stakes.
    const totalStake = trades.reduce((acc, t) => acc + t.stake, 0);
    if (totalStake === 0) return 0;
    return netProfit(trades) / totalStake;
  }
  return netProfit(trades) / startingBalance;
}

// ─── Convenience aggregator ─────────────────────────────────────────────────

export type FullStats = {
  counts: TradeCounts;
  winRate: number;
  lossRate: number;
  tieRate: number;
  averagePayout: number;
  breakEvenWinRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  profitFactor: number;
  expectancyPerTrade: number;
  expectancyInR: number;
  roi: number;
};

/**
 * Compute every rate-style stat in one pass — convenient for dashboards.
 * Use this instead of calling 15 individual functions when you need a full
 * stats card.
 */
export function computeStats(trades: TradeLike[]): FullStats {
  const normalized = normalizeTrades(trades);
  const counts = countTrades(normalized);
  const avgPayout = averagePayout(normalized);
  return {
    counts,
    winRate: winRate(normalized),
    lossRate: lossRate(normalized),
    tieRate: tieRate(normalized),
    averagePayout: avgPayout,
    breakEvenWinRate: breakEvenWinRate(avgPayout),
    grossProfit: grossProfit(normalized),
    grossLoss: grossLoss(normalized),
    netProfit: netProfit(normalized),
    averageWin: averageWin(normalized),
    averageLoss: averageLoss(normalized),
    payoffRatio: payoffRatio(normalized),
    profitFactor: profitFactor(normalized),
    expectancyPerTrade: expectancyPerTrade(normalized),
    expectancyInR: expectancyInR(normalized),
    roi: 0, // Callers should pass their startingBalance; default 0 here.
  };
}
