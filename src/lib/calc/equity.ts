/**
 * Phase 6 — Equity curve, drawdowns, recovery factor, streaks.
 *
 * All functions assume `trades` is already normalized (see normalize.ts) and
 * sorted chronologically — `normalizeTrades()` does both. Equity walks and
 * drawdown peaks depend on order, so callers must normalize first.
 *
 * Edge cases:
 *   - Zero trades → equityCurve returns [startBalance], drawdown = 0,
 *     streaks = 0.
 *   - All wins → no drawdown, longest loss streak = 0, current streak = N
 *     (positive).
 *   - All losses → maxDrawdown = startBalance - (start - N×stake),
 *     longest loss streak = N, current streak = -N.
 */
import type { NormalizedTrade } from "./types";
import { normalizeTrades } from "./normalize";
import type { TradeLike } from "./types";

// ─── Equity curve ──────────────────────────────────────────────────────────

/**
 * Equity curve — running balance after each trade in chronological order.
 *
 * Returns an array of length N+1 where:
 *   - index 0 = startBalance
 *   - index i = balance after the i-th trade (i = 1..N)
 *
 * Caller must pass the account's starting balance (or the balance at the
 * start of the date range being analyzed). For an absolute equity curve,
 * pass the account's `startingBalance` Prisma field.
 */
export function equityCurve(trades: NormalizedTrade[], startBalance: number): number[] {
  if (trades.length === 0) return [startBalance];
  const out = [startBalance];
  let running = startBalance;
  for (const t of trades) {
    running += t.profitLoss;
    out.push(running);
  }
  return out;
}

// ─── Drawdowns ───────────────────────────────────────────────────────────────

export type DrawdownStats = {
  /** Largest peak-to-trough drop in account currency. */
  maxDrawdown: number;
  /** Largest peak-to-trough drop as a fraction of the peak (0..1). */
  maxDrawdownPercent: number;
  /** Index in the equity curve where the max drawdown bottomed out. */
  maxDrawdownBottomIndex: number;
  /** Current drawdown = current peak - current balance (0 if at a new high). */
  currentDrawdown: number;
  /** Current drawdown as a fraction of the current peak. */
  currentDrawdownPercent: number;
};

/**
 * Compute drawdown stats from an equity curve.
 *
 * For each point in the curve, drawdown = (peak so far) - (current balance).
 * The max drawdown is the largest of these. The current drawdown is the
 * drawdown at the last point in the curve.
 */
export function drawdownStats(equity: number[]): DrawdownStats {
  if (equity.length === 0) {
    return {
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      maxDrawdownBottomIndex: 0,
      currentDrawdown: 0,
      currentDrawdownPercent: 0,
    };
  }
  let peak = equity[0];
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let maxDrawdownBottomIndex = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = peak - equity[i];
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = peak > 0 ? dd / peak : 0;
      maxDrawdownBottomIndex = i;
    }
  }
  // Current drawdown is from the last peak to the last balance.
  const last = equity[equity.length - 1];
  let lastPeak = equity[0];
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > lastPeak) lastPeak = equity[i];
  }
  const currentDrawdown = Math.max(0, lastPeak - last);
  const currentDrawdownPercent = lastPeak > 0 ? currentDrawdown / lastPeak : 0;
  return {
    maxDrawdown,
    maxDrawdownPercent,
    maxDrawdownBottomIndex,
    currentDrawdown,
    currentDrawdownPercent,
  };
}

// ─── Recovery factor ────────────────────────────────────────────────────────

/**
 * Recovery factor = netProfit / maxDrawdown.
 *
 * > 1 means the trader has recovered more than they've ever lost.
 * High value = quick recovery from drawdowns.
 * Infinity if no drawdown (and positive netProfit).
 * 0 if no netProfit.
 */
export function recoveryFactor(netProfit: number, maxDrawdown: number): number {
  if (maxDrawdown === 0) {
    return netProfit > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return netProfit / maxDrawdown;
}

// ─── Streaks ──────────────────────────────────────────────────────────────────

export type StreakStats = {
  /** Longest run of WIN trades. */
  longestWinStreak: number;
  /** Longest run of LOSS trades. */
  longestLossStreak: number;
  /** Current streak — positive for wins, negative for losses, 0 for ties/empty. */
  currentStreak: number;
};

/**
 * Compute longest win/loss streaks + current streak.
 *
 * Trades must be in chronological order (use normalizeTrades first).
 * Ties reset the current streak but don't count toward win/loss streaks.
 * Zero trades → all streaks = 0.
 */
export function computeStreaks(trades: NormalizedTrade[]): StreakStats {
  if (trades.length === 0) {
    return { longestWinStreak: 0, longestLossStreak: 0, currentStreak: 0 };
  }
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let currentRun = 0;
  let currentType: "WIN" | "LOSS" | "TIE" | null = null;

  for (const t of trades) {
    if (t.result === currentType) {
      currentRun++;
    } else {
      currentType = t.result;
      currentRun = 1;
    }
    if (t.result === "WIN" && currentRun > longestWinStreak) {
      longestWinStreak = currentRun;
    } else if (t.result === "LOSS" && currentRun > longestLossStreak) {
      longestLossStreak = currentRun;
    }
  }

  // Compute current streak (signed).
  const last = trades[trades.length - 1].result;
  let currentStreak = 0;
  if (last === "WIN" || last === "LOSS") {
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].result === last) {
        currentStreak += last === "WIN" ? 1 : -1;
      } else {
        break;
      }
    }
  }

  return { longestWinStreak, longestLossStreak, currentStreak };
}

// ─── Convenience aggregator ─────────────────────────────────────────────────

export type EquityStats = {
  equity: number[];
  drawdown: DrawdownStats;
  recoveryFactor: number;
  streaks: StreakStats;
};

/**
 * Compute the full equity-curve analysis in one call — convenient for the
 * dashboard's "equity curve" + "max drawdown" cards.
 */
export function computeEquityStats(trades: TradeLike[], startBalance: number): EquityStats {
  const normalized = normalizeTrades(trades);
  const equity = equityCurve(normalized, startBalance);
  const drawdown = drawdownStats(equity);
  const np = normalized.reduce((acc, t) => acc + t.profitLoss, 0);
  return {
    equity,
    drawdown,
    recoveryFactor: recoveryFactor(np, drawdown.maxDrawdown),
    streaks: computeStreaks(normalized),
  };
}
