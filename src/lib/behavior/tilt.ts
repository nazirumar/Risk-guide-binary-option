/**
 * Phase 16 — Tilt & revenge-trade detection engine.
 *
 * Pure function: `detectTilt(recentTrades, config, now)` returns a composite
 * tilt score (0–100) + level (CALM/CAUTION/TILT) + signals[] explaining WHY.
 *
 * Each signal has a weight. The score is the sum of triggered weights,
 * clamped to 0–100. Signals are explanations, not just booleans — each one
 * carries a human-readable `detail` string.
 *
 * Edge cases: no history → CALM (score 0). First trade of the day → only
 * emotion + trading-hours signals can fire.
 */
import Decimal from "decimal.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TiltTradeLike = {
  id: string;
  openedAt: Date;
  stake: Decimal | string | number;
  result: "WIN" | "LOSS" | "TIE" | "OPEN";
  emotion: string | null;
  profitLoss: Decimal | string | number;
};

export type TiltConfig = {
  /** Whether tilt detection is enabled. If false, returns CALM immediately. */
  tiltDetectionEnabled: boolean;
  /** Score (0–100) above which the level is TILT. Default 60. */
  tiltThreshold: number;
  /** Minutes after a loss before re-entering is "rapid re-trade". Default 2. */
  rapidRetradeMinutes: number;
  /** Multiplier vs median stake — stake > median × factor after a loss = signal. Default 1.5. */
  stakeEscalationFactor: number;
  /** Trades in the last hour above which is "rapid trading". Default 6. */
  maxTradesPerHour: number;
  /** User's trading hours — null = no time-of-day check. */
  tradingHours: { start: string; end: string; days: number[] } | null;
};

export type TiltSignal = {
  signal: string;
  weight: number;
  detail: string;
};

export type TiltResult = {
  score: number;
  level: "CALM" | "CAUTION" | "TILT";
  signals: TiltSignal[];
};

// ─── Signal weights (sum = 100) ─────────────────────────────────────────────

export const SIGNAL_WEIGHTS = {
  RAPID_RETRADE: 20,
  STAKE_SPIKE_AFTER_LOSS: 20,
  CONSECUTIVE_LOSSES: 15,
  RAPID_TRADING: 15,
  OUTSIDE_TRADING_HOURS: 10,
  NEGATIVE_EMOTION: 10,
  STAKE_ESCALATION_PATTERN: 10,
} as const;

const NEGATIVE_EMOTIONS = new Set(["REVENGE", "GREEDY", "TIRED", "FEARFUL"]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function toNumber(v: Decimal | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  try {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    return new Decimal(v.toString()).toNumber();
  } catch {
    return 0;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseTimeStr(t: string): { h: number; m: number } {
  const [h, m] = t.split(":").map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

function isOutsideTradingHours(
  now: Date,
  hours: { start: string; end: string; days: number[] },
): boolean {
  const utcDay = now.getUTCDay();
  if (!hours.days.includes(utcDay)) return true;
  const start = parseTimeStr(hours.start);
  const end = parseTimeStr(hours.end);
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const nowMinutes = utcHour * 60 + utcMin;
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;
  return nowMinutes < startMinutes || nowMinutes > endMinutes;
}

// ─── Main function ─────────────────────────────────────────────────────────

export function detectTilt(
  trades: TiltTradeLike[],
  config: TiltConfig,
  now: Date = new Date(),
): TiltResult {
  const signals: TiltSignal[] = [];

  // If detection is disabled, return CALM immediately.
  if (!config.tiltDetectionEnabled) {
    return { score: 0, level: "CALM", signals };
  }

  // Normalize: sort most-recent-first, filter OPEN, convert stakes to numbers.
  const closed = trades
    .filter((t) => t.result !== "OPEN")
    .map((t) => ({
      ...t,
      stakeNum: toNumber(t.stake),
      profitLossNum: toNumber(t.profitLoss),
      openedAt: t.openedAt instanceof Date ? t.openedAt : new Date(t.openedAt),
    }))
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime()); // most recent first

  const nowMs = now.getTime();

  // ─── Signal 1: RAPID_RETRADE ────────────────────────────────────────────
  // Most recent trade was a LOSS, and a new trade would open < X minutes after it.
  if (closed.length >= 1) {
    const last = closed[0];
    if (last.result === "LOSS") {
      const msSinceLast = nowMs - last.openedAt.getTime();
      const thresholdMs = config.rapidRetradeMinutes * 60 * 1000;
      if (msSinceLast < thresholdMs) {
        signals.push({
          signal: "RAPID_RETRADE",
          weight: SIGNAL_WEIGHTS.RAPID_RETRADE,
          detail: `Last loss was ${Math.floor(msSinceLast / 60000)} min ago (threshold: ${config.rapidRetradeMinutes} min).`,
        });
      }
    }
  }

  // ─── Signal 2: STAKE_SPIKE_AFTER_LOSS ──────────────────────────────────
  // The second most recent trade was a LOSS, and the most recent trade
  // (placed after the loss) has a stake > median × factor. This is the
  // revenge-trading pattern: lose → increase stake → try to win it back.
  if (closed.length >= 2) {
    const prev = closed[1]; // the LOSS trade
    const current = closed[0]; // the trade placed AFTER the loss
    if (prev.result === "LOSS" && current.stakeNum > 0) {
      // Compute median stake from the last 30 days (excluding the most recent trade).
      const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000;
      const medianStakes = closed
        .filter((t) => t.openedAt.getTime() >= thirtyDaysAgo && t.id !== current.id)
        .map((t) => t.stakeNum);
      const med = median(medianStakes);
      if (med > 0 && current.stakeNum > med * config.stakeEscalationFactor) {
        signals.push({
          signal: "STAKE_SPIKE_AFTER_LOSS",
          weight: SIGNAL_WEIGHTS.STAKE_SPIKE_AFTER_LOSS,
          detail: `Stake ${current.stakeNum.toFixed(2)} is ${(current.stakeNum / med).toFixed(1)}× the 30-day median (${med.toFixed(2)}) — placed right after a loss.`,
        });
      }
    }
  }

  // ─── Signal 3: CONSECUTIVE_LOSSES ──────────────────────────────────────
  // 2+ consecutive losses followed by another trade.
  if (closed.length >= 2) {
    let lossStreak = 0;
    for (const t of closed) {
      if (t.result === "LOSS") lossStreak++;
      else break;
    }
    if (lossStreak >= 2) {
      signals.push({
        signal: "CONSECUTIVE_LOSSES",
        weight: SIGNAL_WEIGHTS.CONSECUTIVE_LOSSES,
        detail: `${lossStreak} consecutive losses. The next trade is likely revenge-driven.`,
      });
    }
  }

  // ─── Signal 4: RAPID_TRADING ───────────────────────────────────────────
  // > N trades in the last hour.
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const tradesLastHour = closed.filter((t) => t.openedAt.getTime() >= oneHourAgo).length;
  if (tradesLastHour > config.maxTradesPerHour) {
    signals.push({
      signal: "RAPID_TRADING",
      weight: SIGNAL_WEIGHTS.RAPID_TRADING,
      detail: `${tradesLastHour} trades in the last hour (threshold: ${config.maxTradesPerHour}).`,
    });
  }

  // ─── Signal 5: OUTSIDE_TRADING_HOURS ──────────────────────────────────
  if (config.tradingHours && isOutsideTradingHours(now, config.tradingHours)) {
    signals.push({
      signal: "OUTSIDE_TRADING_HOURS",
      weight: SIGNAL_WEIGHTS.OUTSIDE_TRADING_HOURS,
      detail: `Current time is outside your configured trading hours (${config.tradingHours.start}–${config.tradingHours.end}).`,
    });
  }

  // ─── Signal 6: NEGATIVE_EMOTION ────────────────────────────────────────
  // Check the last 3 trades for REVENGE, GREEDY, TIRED, or FEARFUL.
  const recentEmotions = closed
    .slice(0, 3)
    .map((t) => t.emotion)
    .filter((e): e is string => e !== null && NEGATIVE_EMOTIONS.has(e));
  if (recentEmotions.length > 0) {
    signals.push({
      signal: "NEGATIVE_EMOTION",
      weight: SIGNAL_WEIGHTS.NEGATIVE_EMOTION,
      detail: `Recent trades tagged: ${recentEmotions.join(", ")}.`,
    });
  }

  // ─── Signal 7: STAKE_ESCALATION_PATTERN ────────────────────────────────
  // Each stake higher than the previous across 3+ trades.
  if (closed.length >= 3) {
    let escalationRun = 1;
    for (let i = 1; i < closed.length; i++) {
      if (closed[i - 1].stakeNum > closed[i].stakeNum) {
        escalationRun++;
        if (escalationRun >= 3) break;
      } else {
        escalationRun = 1;
      }
    }
    if (escalationRun >= 3) {
      signals.push({
        signal: "STAKE_ESCALATION_PATTERN",
        weight: SIGNAL_WEIGHTS.STAKE_ESCALATION_PATTERN,
        detail: `${escalationRun} consecutive trades with increasing stakes.`,
      });
    }
  }

  // ─── Score + level ────────────────────────────────────────────────────
  const score = Math.min(
    100,
    signals.reduce((acc, s) => acc + s.weight, 0),
  );
  const level: TiltResult["level"] =
    score >= config.tiltThreshold ? "TILT" : score >= 40 ? "CAUTION" : "CALM";

  return { score, level, signals };
}
