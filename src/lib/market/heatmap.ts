/**
 * Phase 27 — Hourly volatility heatmap (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: pure calc in `/src/lib`, unit-tested. The
 * nightly job in `src/server/actions/market-conditions.ts` loads candles and
 * calls these helpers, then upserts the resulting rows into
 * `HourlyVolatilityStat`.)
 *
 * The heatmap answers: "for this pair, how active is each weekday × UTC hour
 * compared to the pair's own history?" We bucket M5 candles by (weekday,
 * hourUtc), compute the ATR% of each bucket, and summarize the distribution
 * with avg / p20 / p50 / p80 plus the number of distinct days sampled.
 *
 * Wording rule (spec): UI copy must say "higher volatility" and "typically
 * active" — never "best time to trade". This module is data-only; the page
 * enforces the wording.
 *
 * Exports:
 *   - computeHourlyVolatility(candles, opts): HourlyVolatilityCell[] — the
 *     rows to upsert, one per (weekday, hourUtc) with enough samples.
 *   - topVolatilityWindows(cells, n): the n highest-p80 windows (for the
 *     "typically active" summary).
 *   - heatmapColorFor(avgAtrPercent, min, max): 0-1 normalized intensity
 *     (0..1) for the color scale.
 */
import { atr, atrPercent } from "./scoring";
import type { Candle } from "./provider";
import { HEATMAP_MIN_SAMPLE_DAYS } from "./scoring-config";

/** One heatmap cell = the volatility profile of a (weekday, hour) bucket. */
export type HourlyVolatilityCell = {
  /** ISO weekday 1=Mon … 7=Sun (matches Prisma's `weekday Int`). */
  weekday: number;
  /** Hour of day 0-23 in UTC. */
  hourUtc: number;
  avgAtrPercent: number;
  p20: number;
  p50: number;
  p80: number;
  /** Number of distinct UTC days that contributed samples. */
  sampleDays: number;
};

/** Nearest-rank quantile (0-100) over an ascending-sorted array. */
export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = ((sortedAsc.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}

/**
 * Bucket M5 candles by (weekday, hourUtc) and summarize each bucket's ATR%
 * distribution. A candle contributes its close-price ATR% as the "activity"
 * reading for its (weekday, hour).
 *
 * Returns only buckets with at least `minSampleDays` distinct days (default
 * `HEATMAP_MIN_SAMPLE_DAYS` = 10) so the UI can hide thin cells. Pass a
 * lower `minSampleDays` in tests.
 */
export function computeHourlyVolatility(
  candles: Candle[],
  opts: { atrPeriod?: number; minSampleDays?: number } = {},
): HourlyVolatilityCell[] {
  const atrPeriod = opts.atrPeriod ?? 14;
  const minSampleDays = opts.minSampleDays ?? HEATMAP_MIN_SAMPLE_DAYS;
  if (candles.length < atrPeriod + 1) return [];

  const sorted = [...candles].sort((a, b) => a.time.getTime() - b.time.getTime());

  // Compute a rolling ATR series aligned to each candle's close.
  // For candle i we need the preceding `atrPeriod` candles.
  type Sample = { weekday: number; hourUtc: number; atrPct: number; dayKey: string };
  const buckets = new Map<string, Sample[]>();

  for (let i = atrPeriod; i < sorted.length; i++) {
    const window = sorted.slice(i - atrPeriod, i + 1);
    const a = atr(window, atrPeriod);
    if (a == null) continue;
    const c = sorted[i];
    const pct = atrPercent(a, c.close);
    const weekday = isoWeekday(c.time);
    const hourUtc = c.time.getUTCHours();
    const dayKey = c.time.toISOString().slice(0, 10);
    const key = `${weekday}:${hourUtc}`;
    const arr = buckets.get(key) ?? [];
    arr.push({ weekday, hourUtc, atrPct: pct, dayKey });
    buckets.set(key, arr);
  }

  const cells: HourlyVolatilityCell[] = [];
  for (const samples of buckets.values()) {
    const days = new Set(samples.map((s) => s.dayKey));
    if (days.size < minSampleDays) continue;
    const values = samples.map((s) => s.atrPct).sort((a, b) => a - b);
    const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
    cells.push({
      weekday: samples[0].weekday,
      hourUtc: samples[0].hourUtc,
      avgAtrPercent: round4(avg),
      p20: round4(quantile(values, 20)),
      p50: round4(quantile(values, 50)),
      p80: round4(quantile(values, 80)),
      sampleDays: days.size,
    });
  }

  cells.sort((a, b) => a.weekday - b.weekday || a.hourUtc - b.hourUtc);
  return cells;
}

/**
 * The n most-active windows by p80 ATR% (descending). Used for the
 * "typically active" summary. Pure — the caller passes already-filtered
 * cells.
 */
export function topVolatilityWindows(cells: HourlyVolatilityCell[], n = 3): HourlyVolatilityCell[] {
  return [...cells].sort((a, b) => b.p80 - a.p80).slice(0, n);
}

/**
 * Normalize an avg ATR% against the min/max across all cells → a 0-1
 * intensity for the color scale. Returns 0.5 when the range collapses.
 */
export function heatmapColorFor(avgAtrPercent: number, min: number, max: number): number {
  if (!Number.isFinite(max) || !Number.isFinite(min) || max <= min) return 0.5;
  return Math.max(0, Math.min(1, (avgAtrPercent - min) / (max - min)));
}

/**
 * Re-bucket UTC heatmap cells into a target timezone for display. Each
 * (weekday, hourUtc) cell is shifted by `offsetMinutes` into local time
 * (weekday rolls over at midnight). Cells that collide in local time are
 * merged: avg/p20/p50/p80 are averaged and `sampleDays` is summed (capped at
 * the number of merged cells' distinct days — good enough for a display grid).
 *
 * `offsetMinutes` is the target TZ's UTC offset (e.g. +60 for BST, -300 for
 * EST). Pass 0 for the UTC view.
 */
export function regridToTimezone(
  cells: HourlyVolatilityCell[],
  offsetMinutes: number,
): HourlyVolatilityCell[] {
  if (offsetMinutes === 0) return [...cells];
  const byKey = new Map<string, HourlyVolatilityCell & { _n: number }>();

  for (const c of cells) {
    const totalMin = c.hourUtc * 60 + offsetMinutes;
    const dayShift = Math.floor(totalMin / (24 * 60));
    const localMin = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
    const localHour = Math.floor(localMin / 60);
    const localWeekday = ((c.weekday - 1 + dayShift + 7) % 7) + 1;

    const key = `${localWeekday}:${localHour}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c, weekday: localWeekday, hourUtc: localHour, _n: 1 });
    } else {
      existing.avgAtrPercent += c.avgAtrPercent;
      existing.p20 += c.p20;
      existing.p50 += c.p50;
      existing.p80 += c.p80;
      existing.sampleDays += c.sampleDays;
      existing._n += 1;
    }
  }

  const merged: HourlyVolatilityCell[] = [];
  for (const c of byKey.values()) {
    merged.push({
      weekday: c.weekday,
      hourUtc: c.hourUtc,
      avgAtrPercent: round4(c.avgAtrPercent / c._n),
      p20: round4(c.p20 / c._n),
      p50: round4(c.p50 / c._n),
      p80: round4(c.p80 / c._n),
      sampleDays: c.sampleDays,
    });
  }
  merged.sort((a, b) => a.weekday - b.weekday || a.hourUtc - b.hourUtc);
  return merged;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** ISO weekday: 1=Mon … 7=Sun. */
function isoWeekday(d: Date): number {
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  return day === 0 ? 7 : day;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
