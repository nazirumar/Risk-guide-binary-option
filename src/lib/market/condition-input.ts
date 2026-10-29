/**
 * Phase 28 — Condition-context builder (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: pure calc in `/src/lib`, unit-tested. This module
 * turns raw DB-shaped rows into the `ConditionContext` that the pure
 * `conditionScore()` consumes. It is shared by the worker's 60s job and the
 * on-demand server action so both compute identical contexts from identical
 * inputs — no divergence between the live dashboard and the drawer.)
 *
 * Everything here is deterministic: no `Date.now()`, no DB, no IO. The caller
 * supplies `now`, the candle rows, the provider status timestamp, the news
 * rows, and the market-closed flag.
 *
 * Exports:
 *   - toCandleRows(rows): normalize Prisma Candle rows → provider `Candle[]`.
 *   - median(values): median of a number array (for the "typical" spread).
 *   - quickAtr(candles): minimal Wilder ATR (plain-number hot path).
 *   - sameHourAtrPercents(candles): ATR% series for an already-same-hour slice.
 *   - computeDataFreshnessSeconds(now, newestCandleAt, lastSuccessAt): the
 *     staleness value that feeds the forced-AVOID rule + the outage banner.
 *   - buildConditionContext(input): assemble a full `ConditionContext`.
 */
import type { NewsEventInput } from "@/lib/news/provider";
import type { Candle } from "@/lib/market/provider";
import {
  conditionScore,
  newsProximity,
  sessionOf,
  type ConditionContext,
} from "@/lib/market/scoring";

/** M5 is the granularity the condition score + cards are computed from. */
export const CONDITION_GRANULARITY = "M5";
/** How far back the condition score looks for candles. */
export const CONDITION_LOOKBACK_DAYS = 20;
/** M5 candles/day ≈ 288; 20 days ≈ 5760. Cap fetch for perf. */
export const MAX_CONDITION_CANDLES = 6000;

/** Prisma Candle row shape (the subset the condition score needs). */
export type CandleRow = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  bid: number | null;
  ask: number | null;
};

/** Normalize Prisma Candle rows → provider `Candle[]` (volume/bid/ask optional). */
export function toCandleRows(rows: CandleRow[]): Candle[] {
  return rows.map((r) => ({
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume ?? undefined,
    bid: r.bid ?? undefined,
    ask: r.ask ?? undefined,
  }));
}

/** Median of numbers (for the "typical" spread). Returns null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Minimal Wilder ATR over a full candle slice (uses the slice length as the
 * period). Plain-number math — this is the hot path for the hourly history and
 * must not pay Decimal overhead. Returns null when there are < 2 candles.
 */
export function quickAtr(candles: Candle[]): number | null {
  const period = candles.length - 1;
  if (period < 1) return null;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const pc = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - pc),
      Math.abs(candles[i].low - pc),
    );
    sum += tr;
  }
  return sum / period;
}

/**
 * ATR% values for each candle in an already-same-hour slice. The caller is
 * responsible for pre-filtering to a single hour-of-day (the pure
 * `volatilityPercentile` compares the current ATR% against the pair's
 * distribution for the SAME hour over the trailing ~20 days).
 */
export function sameHourAtrPercents(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const window = candles.slice(i - 1, i + 1);
    const a = quickAtr(window);
    if (a == null) continue;
    const close = candles[i].close;
    if (close > 0) out.push((a / close) * 100);
  }
  return out;
}

/**
 * Data freshness in seconds. Prefer the newest candle's timestamp; fall back to
 * the provider's last-success time; `Infinity` when neither exists (forces the
 * stale-data AVOID rule — we never assume fresh data).
 */
export function computeDataFreshnessSeconds(
  now: Date,
  newestCandleAt: Date | null,
  lastSuccessAt: Date | null,
): number {
  if (newestCandleAt) return (now.getTime() - newestCandleAt.getTime()) / 1000;
  if (lastSuccessAt) return (now.getTime() - lastSuccessAt.getTime()) / 1000;
  return Infinity;
}

/** Raw news row as it comes out of the DB (impact stored as a plain string). */
export type ConditionNewsRow = {
  currency: string;
  title: string;
  /** Raw impact column value ("HIGH"/"high"/garbage) — normalized below. */
  impact: string;
  scheduledAt: Date;
};

/**
 * Normalize a raw DB impact string to the `NewsImpact` union. Upper-cases and
 * validates membership; unrecognized values fall back to "LOW" — the same
 * precedent the news provider uses (provider.ts normalization). This keeps the
 * pure builder honest about its inputs while staying tolerant of dirty rows.
 */
export function normalizeImpact(raw: string): NewsEventInput["impact"] {
  const up = String(raw ?? "").toUpperCase();
  return up === "HIGH" || up === "MEDIUM" || up === "LOW" ? up : "LOW";
}

export type ConditionContextInput = {
  pair: string;
  now: Date;
  /** M5 candle rows (ascending by time) for the pair. */
  candleRows: CandleRow[];
  /** Provider's last successful poll time (fallback freshness source). */
  lastSuccessAt: Date | null;
  /** Upcoming HIGH-impact news rows (global). null = feed unavailable. */
  newsRows: ConditionNewsRow[] | null;
  /** Whether the market is currently closed. */
  marketClosed: boolean;
};

/**
 * Assemble a `ConditionContext` from raw DB-shaped inputs. Pure — the caller
 * fetches rows and passes `now`. News is passed as raw rows (or null for
 * UNKNOWN); this function does NOT filter by currency — `conditionScore`'s
 * `newsProximity` does that using the pair's two currencies.
 */
export function buildConditionContext(input: ConditionContextInput): ConditionContext {
  const { pair, now, candleRows, lastSuccessAt, newsRows, marketClosed } = input;
  const candles = toCandleRows(candleRows);

  const newestCandleAt = candles.length > 0 ? candles[candles.length - 1].time : null;
  const dataFreshnessSeconds = computeDataFreshnessSeconds(now, newestCandleAt, lastSuccessAt);

  // Spread: ask - bid from the latest candle; typical = median of recent spreads.
  const spreads = candles
    .filter((c) => c.bid != null && c.ask != null)
    .map((c) => (c.ask as number) - (c.bid as number));
  const currentSpread = spreads.length > 0 ? spreads[spreads.length - 1] : null;
  const typicalSpread = median(spreads.slice(-2000));

  // Historical ATR% for the SAME hour of day over the trailing ~20 days.
  const hourUtc = now.getUTCHours();
  const sameHourCandles = candles.filter((c) => c.time.getUTCHours() === hourUtc);
  const historicalAtrPercents = sameHourAtrPercents(sameHourCandles);

  // News: pass rows straight through (null stays UNKNOWN — never assume "no news").
  const newsEvents: NewsEventInput[] | null = newsRows
    ? newsRows.map((r) => ({
        currency: r.currency,
        title: r.title,
        impact: normalizeImpact(r.impact),
        scheduledAt: r.scheduledAt,
      }))
    : null;

  return {
    pair,
    now,
    candles,
    currentSpread,
    typicalSpread,
    historicalAtrPercents,
    newsEvents,
    marketClosed,
    dataFreshnessSeconds,
  };
}

/** Display metadata the dashboard cards read (stored in `MarketCondition.meta`). */
export type ConditionMeta = {
  session: string;
  currentSpread: number | null;
  typicalSpread: number | null;
  spreadRatio: number | null;
  volatilityPercentile: number | null;
  marketClosed: boolean;
  dataFreshnessSeconds: number;
  /** Next HIGH-impact news for THIS pair's currencies (from newsProximity). */
  nextNewsTitle: string | null;
  nextNewsMinutesTo: number | null;
  /** False when the news feed was unavailable — the news factor is UNKNOWN. */
  newsKnown: boolean;
};

/**
 * Compute the display metadata for a pair from a built context + its score.
 * Pure. `nextNews*` comes from the same `newsProximity` the score used, so the
 * card's countdown matches the factor that actually influenced the rating.
 */
export function computeConditionMeta(
  ctx: ConditionContext,
  factors: Array<{ key: string; percentile?: number | null }>,
): ConditionMeta {
  // Re-derive the news proximity + session from the same inputs the score used.
  // (sessionOf + newsProximity are pure and cheap.)
  const session = sessionOf(ctx.now);
  const news = newsProximity({ pair: ctx.pair, now: ctx.now, events: ctx.newsEvents });
  const volFactor = factors.find((f) => f.key === "volatility");
  const spreadR =
    ctx.currentSpread != null && ctx.typicalSpread != null && ctx.typicalSpread > 0
      ? ctx.currentSpread / ctx.typicalSpread
      : null;

  return {
    session,
    currentSpread: ctx.currentSpread,
    typicalSpread: ctx.typicalSpread,
    spreadRatio: spreadR,
    volatilityPercentile: volFactor?.percentile ?? null,
    marketClosed: ctx.marketClosed,
    dataFreshnessSeconds: Number.isFinite(ctx.dataFreshnessSeconds) ? ctx.dataFreshnessSeconds : -1,
    nextNewsTitle: news.nextTitle,
    nextNewsMinutesTo: news.minutesToNext,
    newsKnown: news.known,
  };
}

// Re-export conditionScore so callers get context-build + score in one import.
export { conditionScore };
