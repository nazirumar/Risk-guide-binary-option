/**
 * Phase 8 — Staking plan implementations.
 *
 * Each plan is a pure function: given the current context + the plan's
 * config, returns the next stake. The Monte Carlo simulator + the Add Trade
 * form's next-stake suggestion both call these.
 *
 * PROJECT_RULES.md rule #12: "Martingale-style staking may exist as an
 * option but must always show a red warning and be OFF by default." The
 * MARTINGALE plan here includes a `maxSteps` cap and the UI shows a red
 * warning + worst-case-exposure calculation when the user picks it.
 */

import type { StakingContext, PlanConfig, StakingPlanFn } from "./types";

// ─── FIXED_AMOUNT ────────────────────────────────────────────────────────────

/** Flat $X per trade — the safest plan, recommended for beginners. */
const fixedAmount: StakingPlanFn = (_ctx, config) => {
  if (config.method !== "FIXED_AMOUNT") return 0;
  return Math.max(0, config.amount);
};

// ─── FIXED_PERCENT ───────────────────────────────────────────────────────────

/** X% of the STARTING balance each trade (not the current balance — see COMPOUNDING for that). */
const fixedPercent: StakingPlanFn = (ctx, config) => {
  if (config.method !== "FIXED_PERCENT") return 0;
  return Math.max(0, ctx.balance * config.percent);
};

// ─── COMPOUNDING ─────────────────────────────────────────────────────────────

/**
 * X% of the CURRENT balance each trade — reinvests profits/losses.
 * Effectively FIXED_PERCENT applied to the running balance.
 */
const compounding: StakingPlanFn = (ctx, config) => {
  if (config.method !== "COMPOUNDING") return 0;
  return Math.max(0, ctx.balance * config.percent);
};

// ─── ANTI_MARTINGALE (increase after wins, capped) ──────────────────────────

/**
 * Anti-Martingale: increase stake after each WIN by `increaseFactor`,
 * decrease to base after any LOSS. Capped at `capPercent` × balance.
 *
 * Example: basePercent=2%, increaseFactor=1.5, capPercent=6%.
 *   - Start: stake = 2% of balance.
 *   - After 1 win: stake = 2% × 1.5 = 3%.
 *   - After 2 wins: stake = 3% × 1.5 = 4.5%.
 *   - After 3 wins: stake = min(4.5% × 1.5 = 6.75%, 6% cap) = 6%.
 *   - After any loss: stake = 2% (reset to base).
 */
const antiMartingale: StakingPlanFn = (ctx, config) => {
  if (config.method !== "ANTI_MARTINGALE") return 0;
  const { basePercent, increaseFactor, capPercent } = config;
  if (ctx.consecutiveWins === 0) {
    return Math.max(0, ctx.balance * basePercent);
  }
  // Stake = base × (increaseFactor ^ consecutiveWins), capped.
  const raw = basePercent * Math.pow(increaseFactor, ctx.consecutiveWins);
  const effective = Math.min(raw, capPercent);
  return Math.max(0, ctx.balance * effective);
};

// ─── FIBONACCI ───────────────────────────────────────────────────────────────

/**
 * Fibonacci staking: 1, 1, 2, 3, 5, 8, 13, 21, ... × baseUnit.
 * Each LOSS advances to the next Fibonacci number; each WIN drops back 2
 * steps. Capped at `maxSteps` to bound exposure.
 *
 * Example: baseUnit=$1, maxSteps=8.
 *   - Start: stake = 1 × baseUnit = $1 (Fib[0] = 1).
 *   - After 1 loss: stake = 1 × baseUnit = $1 (Fib[1] = 1).
 *   - After 2 losses: stake = 2 × baseUnit = $2 (Fib[2] = 2).
 *   - After 3 losses: stake = 3 × baseUnit = $3 (Fib[3] = 3).
 *   - After 4 losses: stake = 5 × baseUnit = $5 (Fib[4] = 5).
 *   - After 1 win (from 4 losses): drops back 2 → Fib[2] = 2 → stake = $2.
 */
const FIB_SEQUENCE = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

const fibonacci: StakingPlanFn = (ctx, config) => {
  if (config.method !== "FIBONACCI") return 0;
  const { baseUnit, maxSteps } = config;
  // Position in the Fibonacci sequence = consecutiveLosses, capped at maxSteps.
  const idx = Math.min(ctx.consecutiveLosses, maxSteps);
  const fib = FIB_SEQUENCE[idx] ?? FIB_SEQUENCE[FIB_SEQUENCE.length - 1];
  return Math.max(0, fib * baseUnit);
};

// ─── MARTINGALE (OFF by default, red warning, hard cap) ────────────────────

/**
 * Martingale: double the stake after each LOSS, reset to base after any WIN.
 *
 * PROJECT_RULES.md rule #12: ships with `maxSteps` hard cap to bound
 * worst-case exposure. The UI shows:
 *   - Red warning when this plan is selected.
 *   - Worst-case total exposure = baseUnit × (2^maxSteps − 1).
 *   - Probability of hitting the cap (1 - winRate)^maxSteps.
 *
 * Example: baseUnit=$1, maxSteps=5.
 *   - Start: stake = $1 (2^0 × base).
 *   - After 1 loss: stake = $2 (2^1 × base).
 *   - After 2 losses: stake = $4 (2^2 × base).
 *   - After 5 losses: stake = $32 (2^5 × base) — then reset to base
 *     (the cap is reached; further losses stay at $32 OR reset — we cap).
 */
const martingale: StakingPlanFn = (ctx, config) => {
  if (config.method !== "MARTINGALE") return 0;
  const { baseUnit, maxSteps } = config;
  const step = Math.min(ctx.consecutiveLosses, maxSteps);
  return Math.max(0, baseUnit * Math.pow(2, step));
};

/**
 * Worst-case total exposure for a Martingale sequence: sum of stakes from
 * step 0 to step `maxSteps` (inclusive). This is the maximum the trader
 * could lose if every trade in the sequence loses.
 *
 * Sum = baseUnit × (2^(maxSteps+1) − 1).
 */
export function martingaleWorstCaseExposure(baseUnit: number, maxSteps: number): number {
  // Sum from k=0 to k=maxSteps of baseUnit × 2^k = baseUnit × (2^(maxSteps+1) − 1).
  return baseUnit * (Math.pow(2, maxSteps + 1) - 1);
}

/**
 * Probability of hitting the Martingale cap: the chance of losing
 * `maxSteps + 1` trades in a row (because after maxSteps losses the stake
 * hits the cap, and one more loss makes it the cap-losing sequence).
 *
 * P = (1 − winRate)^(maxSteps + 1).
 */
export function martingaleCapHitProbability(winRate: number, maxSteps: number): number {
  return Math.pow(1 - winRate, maxSteps + 1);
}

// ─── KELLY_FRACTION ─────────────────────────────────────────────────────────

/**
 * Kelly Criterion: the optimal stake size for maximizing long-term growth.
 *
 * Full Kelly fraction:
 *   f = (winRate × (1 + payout) − 1) / payout
 *      = (winRate × payout − (1 − winRate)) / payout
 *      = edge / odds
 *
 * Stake = f × balance, where `fraction` scales f (1 = full, 0.5 = half,
 * 0.25 = quarter). Full Kelly is mathematically optimal for log-growth but
 * extremely volatile — most professionals use half or quarter Kelly.
 *
 * Edge case: if edge ≤ 0 (negative expectancy), Kelly says stake = 0
 * (don't trade). We return 0 in that case.
 */
const kellyFraction: StakingPlanFn = (ctx, config) => {
  if (config.method !== "KELLY_FRACTION") return 0;
  const { fraction } = config;
  const w = ctx.winRate;
  const b = ctx.payoutPercent;
  // Edge = w × b − (1 − w) = w × (1 + b) − 1.
  const edge = w * (1 + b) - 1;
  if (edge <= 0) return 0;
  // f = edge / b.
  const fullKellyFraction = edge / b;
  const scaledFraction = fullKellyFraction * fraction;
  return Math.max(0, ctx.balance * scaledFraction);
};

/** Returns the full Kelly fraction (without balance multiplication). */
export function kellyFullFraction(winRate: number, payoutPercent: number): number {
  const edge = winRate * (1 + payoutPercent) - 1;
  if (edge <= 0) return 0;
  return edge / payoutPercent;
}

// ─── CUSTOM ladder ──────────────────────────────────────────────────────────

/**
 * Custom ladder: user-defined stakes per trade index. After the ladder is
 * exhausted, repeat the last stake indefinitely.
 *
 * Example: ladder = [$10, $20, $30, $40] (good for the first 4 trades of a
 * session).
 *   - Trade 1: stake = $10.
 *   - Trade 2: stake = $20.
 *   - Trade 3: stake = $30.
 *   - Trade 4: stake = $40.
 *   - Trade 5+: stake = $40 (last value).
 */
const customLadder: StakingPlanFn = (ctx, config) => {
  if (config.method !== "CUSTOM") return 0;
  const { ladder } = config;
  if (ladder.length === 0) return 0;
  const idx = Math.min(ctx.tradeNumber - 1, ladder.length - 1);
  return Math.max(0, ladder[idx]);
};

// ─── Registry/dispatcher ───────────────────────────────────────────────────

const PLAN_REGISTRY: Record<string, StakingPlanFn> = {
  FIXED_AMOUNT: fixedAmount,
  FIXED_PERCENT: fixedPercent,
  COMPOUNDING: compounding,
  ANTI_MARTINGALE: antiMartingale,
  FIBONACCI: fibonacci,
  MARTINGALE: martingale,
  KELLY_FRACTION: kellyFraction,
  CUSTOM: customLadder,
};

/**
 * Dispatch: pick the right plan function by `method` and call it. Returns 0
 * for unknown methods (defensive).
 */
export function computeNextStake(ctx: StakingContext, config: PlanConfig): number {
  const fn = PLAN_REGISTRY[config.method];
  if (!fn) return 0;
  return fn(ctx, config);
}

/** Type guard: is this config a Martingale? Used by the UI to show the red warning. */
export function isMartingale(config: PlanConfig): boolean {
  return config.method === "MARTINGALE";
}

/** Default config for each method — used by the UI when creating a new plan. */
export const DEFAULT_CONFIGS: Record<string, PlanConfig> = {
  FIXED_AMOUNT: { method: "FIXED_AMOUNT", amount: 10 },
  FIXED_PERCENT: { method: "FIXED_PERCENT", percent: 0.02 },
  COMPOUNDING: { method: "COMPOUNDING", percent: 0.02 },
  ANTI_MARTINGALE: {
    method: "ANTI_MARTINGALE",
    basePercent: 0.02,
    increaseFactor: 1.5,
    capPercent: 0.06,
  },
  FIBONACCI: { method: "FIBONACCI", baseUnit: 1, maxSteps: 8 },
  MARTINGALE: { method: "MARTINGALE", baseUnit: 1, maxSteps: 5 },
  KELLY_FRACTION: { method: "KELLY_FRACTION", fraction: 0.5 }, // half Kelly by default
  CUSTOM: { method: "CUSTOM", ladder: [10, 20, 30, 40] },
};
