/**
 * Phase 6 — Risk of ruin, losses to ruin, consistency score.
 *
 * Risk of ruin uses the standard fixed-fractional-betting gambler's-ruin
 * approximation. Losses-to-ruin is a simple arithmetic calculator. The
 * consistency score is a Sharpe-like ratio of mean per-trade return to its
 * standard deviation.
 *
 * All functions are pure and accept either normalized trades or the raw
 * TradeLike[] shape (they normalize internally).
 */
import { normalizeTrades } from "./normalize";
import type { TradeLike, NormalizedTrade } from "./types";

// ─── Risk of ruin ────────────────────────────────────────────────────────────

/**
 * Risk of ruin — the probability that a trader's balance will eventually
 * fall to the ruin threshold (e.g. 50% of starting balance) under repeated
 * fixed-fractional betting.
 *
 * Formula (gambler's ruin approximation):
 *   edge = winRate × (1 + payout) − 1
 *   riskUnits = (1 − ruinThreshold) / riskPerTrade
 *   RoR = ((1 − edge) / (1 + edge)) ^ riskUnits   (when edge > 0)
 *   RoR = 1.0                                      (when edge ≤ 0 — certain ruin)
 *
 * Inputs:
 *   winRate: 0..1
 *   payout:   0..1 (broker payout fraction)
 *   riskPerTrade: 0..1 (fraction of balance risked per trade, e.g. 0.02 for 2%)
 *   ruinThreshold: 0..1 (fraction of starting balance considered "ruined", e.g. 0.5)
 *
 * Edge case: any input out of range → 0 or 1 (see function body).
 */
export function riskOfRuin(
  winRate: number,
  payout: number,
  riskPerTrade: number,
  ruinThreshold: number = 0.5,
): number {
  // Sanity-check inputs — return safe defaults.
  if (
    winRate <= 0 ||
    winRate >= 1 ||
    payout < 0 ||
    riskPerTrade <= 0 ||
    ruinThreshold <= 0 ||
    ruinThreshold >= 1
  ) {
    // If winRate is 0 or 1, the outcome is deterministic.
    if (winRate >= 1) return 0; // never loses → never ruined
    if (winRate <= 0) return 1; // never wins → certain ruin
    // Other invalid inputs → fail safe to "certain ruin" so callers notice.
    return 1;
  }

  // Edge per trade as fraction of stake. If winRate is 0.55 and payout is 0.85,
  // edge = 0.55 × 1.85 − 1 = 1.0175 − 1 = +0.0175 (1.75% edge per trade).
  const edge = winRate * (1 + payout) - 1;

  if (edge <= 0) {
    // Negative or zero expected value → eventual ruin is certain.
    return 1;
  }

  // Number of consecutive losing bets before the ruin threshold is reached.
  // With riskPerTrade=0.02 and ruinThreshold=0.5, you need to lose 25 in a
  // row (geometric: 0.98^N <= 0.5 → N = log(0.5)/log(0.98) ≈ 34.3).
  // For the simpler arithmetic case (flat-betting), it'd be 25.
  const riskUnits = Math.log(ruinThreshold) / Math.log(1 - riskPerTrade);

  // Gambler's-ruin formula. Result is a fraction 0..1.
  return Math.pow((1 - edge) / (1 + edge), riskUnits);
}

// ─── Losses to ruin ─────────────────────────────────────────────────────────

/**
 * Losses-to-ruin — how many consecutive losing trades at the current stake
 * it would take to push the account balance below the ruin threshold.
 *
 * Arithmetic (flat-betting) formula:
 *   startingBalance − N × stake ≤ startingBalance × ruinThreshold
 *   N ≥ startingBalance × (1 − ruinThreshold) / stake
 *   N = ceil(startingBalance × (1 − ruinThreshold) / stake)
 *
 * Examples:
 *   - $1000 balance, $20 stake, ruin threshold 0.5 → ceil(500/20) = 25 losses
 *   - $1000 balance, $50 stake, ruin threshold 0.5 → ceil(500/50) = 10 losses
 *
 * Edge cases:
 *   - stake ≤ 0 → 0 (can't lose on a zero-stake trade)
 *   - ruinThreshold ≤ 0 → 0 (can never go below 0)
 *   - ruinThreshold ≥ 1 → 0 (already at or below threshold)
 */
export function lossesToRuin(
  startingBalance: number,
  stake: number,
  ruinThreshold: number = 0.5,
): number {
  if (stake <= 0 || startingBalance <= 0) return 0;
  if (ruinThreshold <= 0) return 0; // can't go below zero balance
  if (ruinThreshold >= 1) return 0; // already at or below threshold

  const lossesNeeded = (startingBalance * (1 - ruinThreshold)) / stake;
  return Math.max(0, Math.ceil(lossesNeeded));
}

// ─── Consistency score (Sharpe-like) ────────────────────────────────────────

/**
 * Sharpe-like consistency score = mean(per-trade returns) / stdDev(per-trade returns).
 *
 * Per-trade return = profitLoss / stake (so it's a stake-relative R-multiple,
 * not absolute currency — this normalizes across different stake sizes).
 *
 * Higher = more consistent. ≥ 1 is good. ≥ 2 is excellent. ≤ 0 is losing.
 * 0 if no trades or all-zero returns (zero std dev).
 *
 * Annualized Sharpe × √252 — for binary options, the per-trade version is
 * more useful. Callers can annualize if they want.
 */
export function consistencyScore(trades: TradeLike[]): number {
  const normalized = normalizeTrades(trades);
  return consistencyScoreNormalized(normalized);
}

/**
 * Internal: same math as `consistencyScore` but accepts already-normalized
 * trades (so the equity module can call it without re-normalizing).
 */
export function consistencyScoreNormalized(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;

  // Compute per-trade returns as fractions of stake.
  // Trades with stake=0 are skipped (avoid divide-by-zero).
  const returns: number[] = [];
  for (const t of trades) {
    if (t.stake > 0) {
      returns.push(t.profitLoss / t.stake);
    }
  }

  if (returns.length < 2) return 0;

  const n = returns.length;
  const mean = returns.reduce((acc, r) => acc + r, 0) / n;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;

  return mean / stdDev;
}

// ─── Convenience aggregator ─────────────────────────────────────────────────

export type RiskStats = {
  /** Risk of ruin as a fraction 0..1. */
  riskOfRuin: number;
  /** Number of consecutive losses at the current stake to reach ruin. */
  lossesToRuin: number;
  /** Sharpe-like consistency score (mean/stdDev of per-trade returns). */
  consistencyScore: number;
};

/**
 * Compute the full risk profile in one call — convenient for the dashboard's
 * "Risk of ruin" card + the analytics page's "Consistency" panel.
 */
export function computeRiskStats(
  trades: TradeLike[],
  startingBalance: number,
  riskPerTrade: number,
  ruinThreshold: number = 0.5,
): RiskStats {
  const normalized = normalizeTrades(trades);
  if (normalized.length === 0) {
    return { riskOfRuin: 0, lossesToRuin: 0, consistencyScore: 0 };
  }
  // Average stake from the trades themselves — useful when the caller
  // doesn't want to pass a specific stake.
  const avgStake = normalized.reduce((acc, t) => acc + t.stake, 0) / normalized.length;
  const wr = normalized.filter((t) => t.result === "WIN").length / normalized.length;
  const avgPayout = normalized.reduce((acc, t) => acc + t.payoutPercent, 0) / normalized.length;
  return {
    riskOfRuin: riskOfRuin(wr, avgPayout, riskPerTrade, ruinThreshold),
    lossesToRuin: lossesToRuin(startingBalance, avgStake, ruinThreshold),
    consistencyScore: consistencyScoreNormalized(normalized),
  };
}
