/**
 * Shared types for the Phase 8 staking-plan engine.
 *
 * Each plan exports a pure function with the signature:
 *   computeNextStake(ctx: StakingContext, config: PlanConfig): number
 *
 * The "context" carries the current balance + recent history the plan needs
 * to decide its next stake. The "config" carries the plan's tunable params
 * (e.g., base stake, increase factor, cap). Different plans have different
 * config shapes — discriminated by `method`.
 */
import type { StakingMethod } from "@prisma/client";

export type TradeOutcome = "WIN" | "LOSS" | "TIE";

/**
 * What the plan function gets: everything it needs to compute the next stake.
 *   - `balance` — current account balance (after the last trade).
 *   - `recentResults` — chronological array of recent outcomes (most recent
 *     first or last? see each plan's docs). Most plans look at the LAST
 *     result(s) to decide increase/decrease.
 *   - `consecutiveLosses` — count of consecutive LOSS trades ending at the
 *     most recent trade. Resets on WIN or TIE.
 *   - `consecutiveWins` — count of consecutive WIN trades ending at the
 *     most recent trade. Resets on LOSS or TIE.
 *   - `tradeNumber` — 1-indexed position in the current session/simulation.
 *   - `payoutPercent` — broker payout fraction (e.g., 0.85).
 *   - `winRate` — user's estimated win rate (0..1). Used by KELLY_FRACTION.
 *   - `ruinThreshold` — fraction of starting balance at which ruin is
 *     declared (used by Monte Carlo; staking plans don't need it but it's
 *     available).
 */
export type StakingContext = {
  balance: number;
  recentResults: TradeOutcome[];
  consecutiveLosses: number;
  consecutiveWins: number;
  tradeNumber: number;
  payoutPercent: number;
  winRate: number;
  ruinThreshold?: number;
};

/**
 * Per-plan config shapes. The `method` field discriminates which to use.
 */
export type PlanConfig =
  | { method: "FIXED_AMOUNT"; amount: number }
  | { method: "FIXED_PERCENT"; percent: number } // 0..1 (e.g., 0.02 = 2%)
  | { method: "COMPOUNDING"; percent: number } // 0..1, like FIXED_PERCENT but reinvested
  | { method: "ANTI_MARTINGALE"; basePercent: number; increaseFactor: number; capPercent: number }
  | { method: "FIBONACCI"; baseUnit: number; maxSteps: number }
  | { method: "MARTINGALE"; baseUnit: number; maxSteps: number } // OFF by default, red warning
  | { method: "KELLY_FRACTION"; fraction: number } // 1 = full Kelly, 0.5 = half, 0.25 = quarter
  | { method: "CUSTOM"; ladder: number[] };

export type StakingPlanFn = (ctx: StakingContext, config: PlanConfig) => number;

/**
 * Result of a single Monte Carlo simulation: ending balance, whether the run
 * hit the ruin threshold, and the max drawdown (peak-to-trough) during the run.
 */
export type SimulationResult = {
  endingBalance: number;
  ruined: boolean;
  maxDrawdown: number;
  maxDrawdownPercent: number;
};

/**
 * Aggregated result of N Monte Carlo simulations.
 */
export type MonteCarloResult = {
  startingBalance: number;
  numSimulations: number;
  numTradesPerSim: number;
  endingBalances: number[]; // raw array for histogram binning
  ruinedCount: number;
  chanceOfRuin: number; // 0..1
  medianEndingBalance: number;
  meanEndingBalance: number;
  p10EndingBalance: number;
  p90EndingBalance: number;
  medianMaxDrawdown: number;
  medianMaxDrawdownPercent: number;
  /** Histogram bins — array of { label, count } for charting. */
  histogram: { label: string; count: number; binStart: number; binEnd: number }[];
};
