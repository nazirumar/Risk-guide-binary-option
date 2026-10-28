"use server";

/**
 * Phase 27 — Market-condition scoring + hourly-volatility heatmap server
 * actions.
 *
 * (PROJECT_RULES.md rule #2: pure calc lives in /src/lib/market/scoring.ts
 * + heatmap.ts. rule #3: market rows are global — no userId — but the
 * actions are reachable only from authed pages; the cron endpoints are
 * token-protected. rule #11: wording stays descriptive — "typically active",
 * never "best time to trade".)
 *
 * Actions:
 *   - `getMarketConditionAction(pair)` — gather candles + spread + news,
 *     call the pure `conditionScore`, cache the result in `MarketCondition`,
 *     and return it. Never throws on provider/news failure — degrades to
 *     UNKNOWN factors (spec: a broken news feed must not assume "no news").
 *
 *   - `recomputeHourlyVolatilityAction(instrumentId?)` — nightly job that
 *     recomputes `HourlyVolatilityStat` rows from stored M5 candles. Idempotent
 *     upserts keyed on (instrumentId, weekday, hourUtc).
 *
 *   - `getHeatmapAction(pair, opts?)` — read the stored heatmap cells for a
 *     pair (+ min/max across cells for the color scale). The page calls this.
 */
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";

import { conditionScore, type ConditionScore } from "@/lib/market/scoring";
import {
  computeHourlyVolatility,
  heatmapColorFor,
  topVolatilityWindows,
  type HourlyVolatilityCell,
} from "@/lib/market/heatmap";
import { isMarketClosed } from "@/lib/market/market-hours";
import { HEATMAP_MIN_SAMPLE_DAYS } from "@/lib/market/scoring-config";
import type { Candle } from "@/lib/market/provider";

const M5 = "M5";
/** How far back the condition + heatmap reads look. */
const LOOKBACK_DAYS = 20;
/** M5 candles/day ≈ 288; 20 days ≈ 5760. Cap fetch for perf. */
const MAX_CANDLES = 6000;

function toCandleRows(
  rows: Array<{
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
    bid: number | null;
    ask: number | null;
  }>,
): Candle[] {
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
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── 1. getMarketConditionAction ────────────────────────────────────────────

export type MarketConditionResult = {
  ok: boolean;
  message: string;
  pair: string;
  condition?: ConditionScore;
};

export async function getMarketConditionAction(pair: string): Promise<MarketConditionResult> {
  // Auth gate (rule #3 — reachable only from authed pages).
  await requireUser();

  const instrument = await db.instrument.findUnique({ where: { symbol: pair } });
  if (!instrument) {
    return { ok: false, message: `Unknown pair "${pair}".`, pair };
  }

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [candleRows, status] = await Promise.all([
    db.candle.findMany({
      where: { instrumentId: instrument.id, granularity: M5, time: { gte: since } },
      orderBy: { time: "asc" },
      select: {
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        bid: true,
        ask: true,
      },
      take: MAX_CANDLES,
    }),
    db.marketDataStatus.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);

  const candles = toCandleRows(candleRows);

  // Data freshness = seconds since the newest candle (or provider success).
  const newestCandleAt = candles.length > 0 ? candles[candles.length - 1].time : null;
  const dataFreshnessSeconds = newestCandleAt
    ? (now.getTime() - newestCandleAt.getTime()) / 1000
    : status?.lastSuccessAt
      ? (now.getTime() - status.lastSuccessAt.getTime()) / 1000
      : Infinity;

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

  // News: fetch upcoming HIGH-impact events for the pair. If the fetch throws,
  // pass null so the news factor is UNKNOWN (never assume "no news").
  let newsEvents: Awaited<ReturnType<typeof fetchUpcomingNews>> | null = null;
  try {
    newsEvents = await fetchUpcomingNews(now);
  } catch {
    newsEvents = null;
  }

  const condition = conditionScore({
    pair,
    now,
    candles,
    currentSpread,
    typicalSpread,
    historicalAtrPercents,
    newsEvents,
    marketClosed: isMarketClosed(now),
    dataFreshnessSeconds,
  });

  // Cache the latest condition for the instrument (1-1 via @@unique).
  await db.marketCondition.upsert({
    where: { instrumentId: instrument.id },
    update: {
      score: condition.score,
      rating: condition.rating,
      factors: condition.factors,
      reasons: condition.reasons,
      computedAt: now,
    },
    create: {
      instrumentId: instrument.id,
      score: condition.score,
      rating: condition.rating,
      factors: condition.factors,
      reasons: condition.reasons,
      computedAt: now,
    },
  });

  return { ok: true, message: "Condition computed.", pair, condition };
}

/** ATR% values for each candle in an already-same-hour slice. */
function sameHourAtrPercents(candles: Candle[]): number[] {
  const out: number[] = [];
  const period = 14;
  for (let i = period; i < candles.length; i++) {
    const window = candles.slice(i - period, i + 1);
    // Inline ATR% via the scoring helpers would re-import; keep it simple.
    const a = quickAtr(window);
    if (a == null) continue;
    const close = candles[i].close;
    if (close > 0) out.push((a / close) * 100);
  }
  return out;
}

/** Minimal Wilder ATR (avoids importing Decimal into the hot path). */
function quickAtr(candles: Candle[]): number | null {
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

/** Upcoming HIGH-impact news for the next 24h (global table, no userId). */
async function fetchUpcomingNews(now: Date) {
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const rows = await db.newsEvent.findMany({
    where: { scheduledAt: { gte: now, lt: to }, impact: "HIGH" },
    select: { currency: true, title: true, impact: true, scheduledAt: true },
  });
  return rows.map((r) => ({
    currency: r.currency,
    title: r.title,
    impact: r.impact as "HIGH",
    scheduledAt: r.scheduledAt,
  }));
}

// ─── 2. recomputeHourlyVolatilityAction (nightly job) ──────────────────────

export type RecomputeResult = {
  ok: boolean;
  message: string;
  instrumentsProcessed: number;
  cellsWritten: number;
};

/**
 * Recompute `HourlyVolatilityStat` for every active instrument from stored
 * M5 candles. Idempotent upserts keyed on (instrumentId, weekday, hourUtc).
 * Called by the nightly cron; safe to re-run.
 */
export async function recomputeHourlyVolatilityAction(
  instrumentId?: string,
): Promise<RecomputeResult> {
  const instruments = await db.instrument.findMany({
    where: { isActive: true, ...(instrumentId ? { id: instrumentId } : {}) },
    select: { id: true, symbol: true },
  });

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  let cellsWritten = 0;

  for (const inst of instruments) {
    const rows = await db.candle.findMany({
      where: { instrumentId: inst.id, granularity: M5, time: { gte: since } },
      orderBy: { time: "asc" },
      select: {
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        bid: true,
        ask: true,
      },
      take: MAX_CANDLES,
    });
    const candles = toCandleRows(rows);
    const cells = computeHourlyVolatility(candles, { minSampleDays: HEATMAP_MIN_SAMPLE_DAYS });

    for (const cell of cells) {
      await db.hourlyVolatilityStat.upsert({
        where: {
          instrumentId_weekday_hourUtc: {
            instrumentId: inst.id,
            weekday: cell.weekday,
            hourUtc: cell.hourUtc,
          },
        },
        update: {
          avgAtrPercent: cell.avgAtrPercent,
          p20: cell.p20,
          p50: cell.p50,
          p80: cell.p80,
          sampleDays: cell.sampleDays,
        },
        create: {
          instrumentId: inst.id,
          weekday: cell.weekday,
          hourUtc: cell.hourUtc,
          avgAtrPercent: cell.avgAtrPercent,
          p20: cell.p20,
          p50: cell.p50,
          p80: cell.p80,
          sampleDays: cell.sampleDays,
        },
      });
      cellsWritten++;
    }
  }

  return {
    ok: true,
    message: `Recomputed hourly volatility for ${instruments.length} instrument(s).`,
    instrumentsProcessed: instruments.length,
    cellsWritten,
  };
}

// ─── 3. getHeatmapAction ────────────────────────────────────────────────────

export type HeatmapResult = {
  ok: boolean;
  message: string;
  pair: string;
  cells: Array<HourlyVolatilityCell & { intensity: number; enoughData: boolean }>;
  topWindows: HourlyVolatilityCell[];
  minAvg: number;
  maxAvg: number;
};

/**
 * Read the stored heatmap cells for a pair + compute the color-scale min/max
 * and the "typically active" top windows. Cells with `sampleDays < 10` are
 * flagged `enoughData: false` so the UI shows "not enough data".
 */
export async function getHeatmapAction(pair: string): Promise<HeatmapResult> {
  await requireUser();

  const instrument = await db.instrument.findUnique({ where: { symbol: pair } });
  if (!instrument) {
    return {
      ok: false,
      message: `Unknown pair "${pair}".`,
      pair,
      cells: [],
      topWindows: [],
      minAvg: 0,
      maxAvg: 0,
    };
  }

  const rows = await db.hourlyVolatilityStat.findMany({
    where: { instrumentId: instrument.id },
    orderBy: [{ weekday: "asc" }, { hourUtc: "asc" }],
  });

  const cells: Array<HourlyVolatilityCell & { intensity: number; enoughData: boolean }> = rows.map(
    (r) => ({
      weekday: r.weekday,
      hourUtc: r.hourUtc,
      avgAtrPercent: r.avgAtrPercent,
      p20: r.p20,
      p50: r.p50,
      p80: r.p80,
      sampleDays: r.sampleDays,
      intensity: 0,
      enoughData: r.sampleDays >= HEATMAP_MIN_SAMPLE_DAYS,
    }),
  );

  const avgs = cells.filter((c) => c.enoughData).map((c) => c.avgAtrPercent);
  const minAvg = avgs.length > 0 ? Math.min(...avgs) : 0;
  const maxAvg = avgs.length > 0 ? Math.max(...avgs) : 0;
  for (const c of cells) {
    c.intensity = c.enoughData ? heatmapColorFor(c.avgAtrPercent, minAvg, maxAvg) : 0;
  }

  const topWindows = topVolatilityWindows(
    cells.filter((c) => c.enoughData),
    3,
  );

  return {
    ok: true,
    message: `${cells.length} heatmap cells for ${pair}.`,
    pair,
    cells,
    topWindows,
    minAvg,
    maxAvg,
  };
}
