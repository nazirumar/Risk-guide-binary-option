/**
 * Phase 8 — Monte Carlo simulator for staking plans.
 *
 * Given a plan + starting balance + win-rate + payout, runs N simulations of
 * T trades each. Returns the distribution of ending balances + chance of
 * ruin + median max drawdown. Used by the Stake Calculator page to render
 * the histogram chart.
 *
 * Pure: deterministic when given a seeded RNG (so tests can assert on
 * exact outputs). Uses a mulberry32 PRNG — same as the seed script.
 */
import type {
  StakingContext,
  PlanConfig,
  SimulationResult,
  MonteCarloResult,
  TradeOutcome,
} from "./types";
import { computeNextStake } from "./plans";

/** mulberry32 — fast deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run a single simulation of T trades.
 *
 * For each trade:
 *   1. Compute the next stake using the plan.
 *   2. Generate a random outcome (WIN with probability winRate, else LOSS).
 *   3. Update balance: +stake*payout if WIN, -stake if LOSS, 0 if TIE.
 *   4. Track the running peak + compute drawdown.
 *   5. If balance ≤ ruinThreshold × startingBalance, mark as ruined + stop early.
 *
 * Returns the ending balance + ruined flag + max drawdown.
 */
export function simulateOnce(
  startingBalance: number,
  numTrades: number,
  winRate: number,
  payoutPercent: number,
  config: PlanConfig,
  rng: () => number,
  ruinThreshold: number = 0,
): SimulationResult {
  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let consecutiveLosses = 0;
  let consecutiveWins = 0;
  let ruined = false;
  const recentResults: TradeOutcome[] = [];

  const ruinCutoff = startingBalance * ruinThreshold;

  for (let i = 0; i < numTrades; i++) {
    if (balance <= ruinCutoff) {
      ruined = true;
      break;
    }

    const ctx: StakingContext = {
      balance,
      recentResults: [...recentResults],
      consecutiveLosses,
      consecutiveWins,
      tradeNumber: i + 1,
      payoutPercent,
      winRate,
      ruinThreshold,
    };

    const stake = computeNextStake(ctx, config);
    if (stake <= 0) break; // plan returns 0 → no more trading
    // Cap stake at current balance (can't stake more than you have).
    const effectiveStake = Math.min(stake, balance);

    const roll = rng();
    let outcome: TradeOutcome;
    if (roll < winRate) outcome = "WIN";
    else if (roll < winRate + 0.02)
      outcome = "TIE"; // 2% tie rate (typical)
    else outcome = "LOSS";

    if (outcome === "WIN") {
      balance += effectiveStake * payoutPercent;
      consecutiveWins++;
      consecutiveLosses = 0;
    } else if (outcome === "LOSS") {
      balance -= effectiveStake;
      consecutiveLosses++;
      consecutiveWins = 0;
    } else {
      // TIE — no P/L, resets both streaks.
      consecutiveLosses = 0;
      consecutiveWins = 0;
    }
    recentResults.push(outcome);
    if (recentResults.length > 20) recentResults.shift();

    // Track peak + drawdown.
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = peak > 0 ? dd / peak : 0;
    }
  }

  return {
    endingBalance: balance,
    ruined,
    maxDrawdown,
    maxDrawdownPercent,
  };
}

/**
 * Run N simulations and aggregate.
 *
 * `seed` makes the simulation deterministic for tests. Production callers
 * can pass `Date.now()` or omit it (defaults to a fresh seed each run).
 */
export function runMonteCarlo(opts: {
  startingBalance: number;
  numSimulations: number;
  numTradesPerSim: number;
  winRate: number;
  payoutPercent: number;
  config: PlanConfig;
  ruinThreshold?: number;
  seed?: number;
}): MonteCarloResult {
  const {
    startingBalance,
    numSimulations,
    numTradesPerSim,
    winRate,
    payoutPercent,
    config,
    ruinThreshold = 0,
    seed = Date.now(),
  } = opts;

  const rng = mulberry32(seed);
  const results: SimulationResult[] = [];
  for (let i = 0; i < numSimulations; i++) {
    results.push(
      simulateOnce(
        startingBalance,
        numTradesPerSim,
        winRate,
        payoutPercent,
        config,
        rng,
        ruinThreshold,
      ),
    );
  }

  // Aggregate.
  const endingBalances = results.map((r) => r.endingBalance);
  const ruinedCount = results.filter((r) => r.ruined).length;
  const sortedBalances = [...endingBalances].sort((a, b) => a - b);
  const sortedDrawdowns = [...results.map((r) => r.maxDrawdown)].sort((a, b) => a - b);
  const sortedDrawdownPcts = [...results.map((r) => r.maxDrawdownPercent)].sort((a, b) => a - b);

  const median = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  };
  const percentile = (arr: number[], p: number): number => {
    if (arr.length === 0) return 0;
    const idx = Math.floor((p / 100) * (arr.length - 1));
    return arr[idx];
  };

  // Build a histogram of ending balances — 10 bins between P10 and P90
  // (or 0 to max if all balanced out at 0).
  const min = Math.min(...sortedBalances);
  const max = Math.max(...sortedBalances);
  const range = max - min;
  const numBins = 10;
  const binWidth = range > 0 ? range / numBins : 1;
  const histogram: { label: string; count: number; binStart: number; binEnd: number }[] = [];
  for (let i = 0; i < numBins; i++) {
    const binStart = min + i * binWidth;
    const binEnd = i === numBins - 1 ? max : min + (i + 1) * binWidth;
    const count = endingBalances.filter((b) =>
      i === numBins - 1 ? b >= binStart && b <= binEnd : b >= binStart && b < binEnd,
    ).length;
    histogram.push({
      label: `${formatShort(binStart)}–${formatShort(binEnd)}`,
      count,
      binStart,
      binEnd,
    });
  }

  return {
    startingBalance,
    numSimulations,
    numTradesPerSim,
    endingBalances,
    ruinedCount,
    chanceOfRuin: ruinedCount / numSimulations,
    medianEndingBalance: median(sortedBalances),
    meanEndingBalance: endingBalances.reduce((acc, b) => acc + b, 0) / endingBalances.length,
    p10EndingBalance: percentile(sortedBalances, 10),
    p90EndingBalance: percentile(sortedBalances, 90),
    medianMaxDrawdown: median(sortedDrawdowns),
    medianMaxDrawdownPercent: median(sortedDrawdownPcts),
    histogram,
  };
}

function formatShort(n: number): string {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toFixed(0);
}
