/**
 * Phase 27 — Market-condition scoring (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib` as pure,
 * unit-tested functions. Money/price math uses `decimal.js`; statistics —
 * percentiles, ADX ratios, choppiness — use plain `number` since they are
 * dimensionless and never summed into a balance.)
 *
 * Every function here is deterministic and DB-free. The server action
 * (`src/server/actions/market-conditions.ts`) gathers candles / spread /
 * news rows and calls these pure helpers, then caches the result in
 * `MarketCondition`.
 *
 * Exports:
 *   - trueRange(candle, prevClose): Wilder's True Range (Decimal).
 *   - atr(candles, period=14): Average True Range via Wilder smoothing.
 *   - atrPercent(atrValue, price): ATR expressed as a percentage of price.
 *   - percentileRank(value, samples): where `value` sits (0-100) in `samples`.
 *   - volatilityPercentile(...): current ATR% vs the pair's same-hour history.
 *   - spreadScore(current, typical): 0-100 (tight spread → high score).
 *   - trendStrength(candles, period=14): ADX(14) + choppiness → TRENDING/
 *     RANGING/CHOPPY.
 *   - sessionOf(timeUtc): ASIAN | LONDON | NEW_YORK | LONDON_NY_OVERLAP |
 *     OFF_HOURS (DST-aware, reuses Phase 22).
 *   - newsProximity(...): minutes to the next high-impact event for the
 *     pair's currencies (reuses Phase 22 data; UNKNOWN when data is absent).
 *   - conditionScore(ctx): the 0-100 score, rating, factors, reasons.
 */
import Decimal from "decimal.js";

import { classifyTradeBySession } from "@/lib/news/sessions";
import { getCurrenciesFromAsset } from "@/lib/news/warning";
import type { NewsEventInput } from "@/lib/news/provider";

import type { Candle } from "./provider";
import {
  CONDITION_WEIGHTS,
  DEFAULT_ATR_PERIOD,
  FORCED_AVOID,
  NEWS,
  RATING_BANDS,
  SPREAD,
  TREND,
  VOLATILITY,
} from "./scoring-config";

// ─── True Range + ATR (decimal.js for price math) ───────────────────────────

/**
 * Wilder's True Range for a single candle given the previous close:
 *   TR = max(high - low, |high - prevClose|, |low - prevClose|).
 */
export function trueRange(candle: Candle, prevClose: number): Decimal {
  const high = new Decimal(candle.high);
  const low = new Decimal(candle.low);
  const prev = new Decimal(prevClose);
  return Decimal.max(high.minus(low), high.minus(prev).abs(), low.minus(prev).abs());
}

/**
 * Average True Range via Wilder's smoothing. Returns the ATR as a plain
 * number (a price distance, not a balance) or null when there aren't enough
 * candles (need `period + 1` to produce `period` true ranges).
 */
export function atr(candles: Candle[], period: number = DEFAULT_ATR_PERIOD): number | null {
  if (period < 1 || candles.length < period + 1) return null;
  const sorted = [...candles].sort((a, b) => a.time.getTime() - b.time.getTime());

  const trs: Decimal[] = [];
  for (let i = 1; i < sorted.length; i++) {
    trs.push(trueRange(sorted[i], sorted[i - 1].close));
  }

  // Seed = simple average of the first `period` TRs, then Wilder-smooth.
  let running = trs
    .slice(0, period)
    .reduce((acc, tr) => acc.plus(tr), new Decimal(0))
    .div(period);
  for (let i = period; i < trs.length; i++) {
    running = running
      .times(period - 1)
      .plus(trs[i])
      .div(period);
  }
  return running.toNumber();
}

/**
 * ATR as a percentage of price: `(atr / price) * 100`. This normalizes ATR
 * across pairs so EURUSD's ATR is comparable to USDJPY's. Returns 0 for a
 * non-positive price.
 */
export function atrPercent(atrValue: number, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return (atrValue / price) * 100;
}

// ─── Percentile helpers ─────────────────────────────────────────────────────

/**
 * What percentile `value` sits at within `samples` (0-100). Uses the
 * "percentage of samples <= value" definition so the result is deterministic
 * and easy to reason about. Returns 50 (neutral) for an empty sample set.
 */
export function percentileRank(value: number, samples: number[]): number {
  if (samples.length === 0) return 50;
  let belowOrEqual = 0;
  for (const s of samples) {
    if (s <= value) belowOrEqual++;
  }
  return (belowOrEqual / samples.length) * 100;
}

/** Minimum historical samples before the volatility percentile is trusted. */
export const MIN_HISTORICAL_ATR_SAMPLES = 5;

export type VolatilityPercentileResult = {
  /** 0-100 percentile of the current ATR% vs history. null when unknown. */
  percentile: number | null;
  /** False when there isn't enough history to judge — the caller must treat
   *  the volatility factor as UNKNOWN (never assume "calm"). */
  known: boolean;
  /** The current ATR% that was ranked (null when candles were insufficient). */
  currentAtrPercent: number | null;
};

/**
 * Compare the current ATR% with the pair's ATR distribution for the SAME
 * hour of day over the last ~20 trading days. `historicalAtrPercents` are
 * the ATR% values recorded for that hour across prior days.
 *
 * The caller (server action) is responsible for slicing candles to the same
 * hour-of-day across the trailing days — this pure function only ranks the
 * current value against the supplied distribution.
 */
export function volatilityPercentile(input: {
  currentAtrPercent: number | null;
  historicalAtrPercents: number[] | null;
}): VolatilityPercentileResult {
  const { currentAtrPercent, historicalAtrPercents } = input;
  if (currentAtrPercent == null) {
    return { percentile: null, known: false, currentAtrPercent: null };
  }
  if (!historicalAtrPercents || historicalAtrPercents.length < MIN_HISTORICAL_ATR_SAMPLES) {
    return { percentile: null, known: false, currentAtrPercent };
  }
  return {
    percentile: percentileRank(currentAtrPercent, historicalAtrPercents),
    known: true,
    currentAtrPercent,
  };
}

// ─── Spread score ───────────────────────────────────────────────────────────

/**
 * Score the current spread against the pair's typical spread (0-100).
 * A spread at/below typical scores 100; a spread at `avoidRatio` (3x typical)
 * scores 0. Returns null when either value is missing or typical is <= 0 —
 * the caller marks the spread factor UNKNOWN rather than guessing.
 *
 *   ratio 1.0 → 100 · ratio 2.0 → 50 · ratio 3.0 → 0
 */
export function spreadScore(
  currentSpread: number | null,
  typicalSpread: number | null,
): number | null {
  if (
    currentSpread == null ||
    typicalSpread == null ||
    !Number.isFinite(currentSpread) ||
    !Number.isFinite(typicalSpread) ||
    typicalSpread <= 0
  ) {
    return null;
  }
  const ratio = currentSpread / typicalSpread;
  const raw = (100 * (FORCED_AVOID.spreadAvoidRatio - ratio)) / (FORCED_AVOID.spreadAvoidRatio - 1);
  return Math.max(0, Math.min(100, raw));
}

/** Ratio of current to typical spread (for the forced-AVOID rule). */
export function spreadRatio(
  currentSpread: number | null,
  typicalSpread: number | null,
): number | null {
  if (
    currentSpread == null ||
    typicalSpread == null ||
    !Number.isFinite(currentSpread) ||
    !Number.isFinite(typicalSpread) ||
    typicalSpread <= 0
  ) {
    return null;
  }
  return currentSpread / typicalSpread;
}

// ─── Trend strength: ADX(14) + choppiness ───────────────────────────────────

export type TrendClassification = "TRENDING" | "RANGING" | "CHOPPY";

export type TrendStrength = {
  /** ADX (0-100). Higher = stronger directional move. */
  adx: number;
  /** Choppiness Index (0-100). Higher = more range-bound / erratic. */
  choppiness: number;
  classification: TrendClassification;
};

type DirectionalMove = { plus: number; minus: number; tr: number };

function directionalMoves(sorted: Candle[]): DirectionalMove[] {
  const out: DirectionalMove[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const up = sorted[i].high - sorted[i - 1].high;
    const down = sorted[i - 1].low - sorted[i].low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = trueRange(sorted[i], sorted[i - 1].close).toNumber();
    out.push({ plus, minus, tr });
  }
  return out;
}

function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

function adxFrom(sorted: Candle[], period: number): number[] {
  const moves = directionalMoves(sorted);
  const smoothPlus = wilderSmooth(
    moves.map((m) => m.plus),
    period,
  );
  const smoothMinus = wilderSmooth(
    moves.map((m) => m.minus),
    period,
  );
  const smoothTR = wilderSmooth(
    moves.map((m) => m.tr),
    period,
  );

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = smoothTR[i] === 0 ? 0 : (100 * smoothPlus[i]) / smoothTR[i];
    const minusDI = smoothTR[i] === 0 ? 0 : (100 * smoothMinus[i]) / smoothTR[i];
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  return wilderSmooth(dx, period);
}

/**
 * Choppiness Index over the trailing `period` candles:
 *   CI = 100 * log10(sum(TR) / (maxHigh - minLow)) / log10(period).
 * Returns 0 when the range collapses (no movement).
 */
export function choppinessIndex(candles: Candle[], period: number = DEFAULT_ATR_PERIOD): number {
  if (candles.length < 2) return 0;
  const sorted = [...candles].sort((a, b) => a.time.getTime() - b.time.getTime());
  const window = sorted.slice(-Math.max(2, period));
  let sumTR = 0;
  for (let i = 1; i < window.length; i++) {
    sumTR += trueRange(window[i], window[i - 1].close).toNumber();
  }
  const highest = Math.max(...window.map((c) => c.high));
  const lowest = Math.min(...window.map((c) => c.low));
  const range = highest - lowest;
  if (range <= 0 || sumTR <= 0) return 0;
  return (100 * Math.log10(sumTR / range)) / Math.log10(period);
}

/**
 * Classify trend strength via ADX(14) + a choppiness measure. Returns null
 * when there aren't enough candles to compute a stable ADX (need ~2 periods).
 *
 *   ADX >= 25                        → TRENDING
 *   ADX <  25 and choppiness >= 61.8 → CHOPPY
 *   otherwise                        → RANGING
 */
export function trendStrength(
  candles: Candle[],
  period: number = DEFAULT_ATR_PERIOD,
): TrendStrength | null {
  if (candles.length < 2 * period + 1) return null;
  const sorted = [...candles].sort((a, b) => a.time.getTime() - b.time.getTime());
  const adxSeries = adxFrom(sorted, period);
  if (adxSeries.length === 0) return null;
  const adx = adxSeries[adxSeries.length - 1];
  const choppiness = choppinessIndex(sorted, period);

  let classification: TrendClassification;
  if (adx >= TREND.adxTrending) classification = "TRENDING";
  else if (choppiness >= TREND.choppinessChoppy) classification = "CHOPPY";
  else classification = "RANGING";

  return { adx, choppiness, classification };
}

// ─── Session (DST-aware, reuses Phase 22) ───────────────────────────────────

export type ScoringSession = "ASIAN" | "LONDON" | "NEW_YORK" | "LONDON_NY_OVERLAP" | "OFF_HOURS";

/**
 * Classify a UTC instant into one of the five scoring sessions. Reuses
 * Phase 22's DST-aware `classifyTradeBySession`, collapsing the brief
 * Asian–London overlap into LONDON (five buckets are enough for scoring).
 */
export function sessionOf(timeUtc: Date): ScoringSession {
  const s = classifyTradeBySession(timeUtc);
  if (s === "ASIAN_LONDON_OVERLAP") return "LONDON";
  return s as ScoringSession;
}

/** Relative "activeness" of each session — higher = typically more liquid. */
export const SESSION_SCORES: Record<ScoringSession, number> = {
  LONDON_NY_OVERLAP: 100,
  LONDON: 85,
  NEW_YORK: 85,
  ASIAN: 60,
  OFF_HOURS: 30,
};

// ─── News proximity (reuses Phase 22; UNKNOWN when data absent) ─────────────

export type NewsProximityResult = {
  /** Minutes to the next HIGH-impact event for the pair's currencies.
   *  null = no upcoming event within the horizon. */
  minutesToNext: number | null;
  /** Title of the next event (when one exists). */
  nextTitle: string | null;
  /** False when the news feed was unavailable — the caller must mark the
   *  news factor UNKNOWN, never assume "no news". */
  known: boolean;
};

/**
 * Minutes from `now` to the next high-impact event affecting the pair's two
 * currencies (or a global "*" event). Passing `events: null` signals the
 * news data was unavailable → `known: false` (UNKNOWN), which is distinct
 * from an empty array that legitimately means "no upcoming events".
 */
export function newsProximity(input: {
  pair: string;
  now: Date;
  events: NewsEventInput[] | null;
  horizonMinutes?: number;
}): NewsProximityResult {
  const { pair, now, events } = input;
  if (events === null) {
    return { minutesToNext: null, nextTitle: null, known: false };
  }
  const currencies = getCurrenciesFromAsset(pair);
  const horizon = input.horizonMinutes ?? 24 * 60;

  let bestMinutes = Infinity;
  let bestTitle: string | null = null;
  for (const e of events) {
    if (e.impact.toUpperCase() !== "HIGH") continue;
    const ccy = e.currency.toUpperCase();
    // A "*" (global) event matches every pair; otherwise the event's currency
    // must be one of the pair's two currencies.
    if (ccy !== "*" && !currencies.includes(ccy) && !currencies.includes("*")) continue;
    const minutes = (e.scheduledAt.getTime() - now.getTime()) / 60_000;
    if (minutes < 0 || minutes > horizon) continue;
    if (minutes < bestMinutes) {
      bestMinutes = minutes;
      bestTitle = e.title;
    }
  }
  if (bestTitle === null) {
    return { minutesToNext: null, nextTitle: null, known: true };
  }
  return { minutesToNext: Math.round(bestMinutes), nextTitle: bestTitle, known: true };
}

// ─── Condition score ────────────────────────────────────────────────────────

export type ConditionRating = "GOOD" | "CAUTION" | "AVOID";

export type ConditionFactorKey = "volatility" | "trend" | "spread" | "session" | "news";

export type ConditionFactor = {
  key: ConditionFactorKey;
  label: string;
  /** 0-100 sub-score, or null when the factor is UNKNOWN (not enough data). */
  score: number | null;
  /** Config weight for this factor. */
  weight: number;
  /** Plain-language note surfaced to the trader. */
  note: string;
  /** Phase 28: raw volatility percentile (0-100) — only on the volatility
   *  factor, for the dashboard card's percentile bar. Null elsewhere / when
   *  history is insufficient. */
  percentile?: number | null;
};

export type ConditionScore = {
  /** Weighted 0-100 score (UNKNOWN factors excluded + weights renormalized). */
  score: number;
  rating: ConditionRating;
  factors: ConditionFactor[];
  /** Plain-language reasons behind the rating. */
  reasons: string[];
  /** Age of the candle data in seconds (feeds the stale-data forced rule). */
  dataFreshnessSeconds: number;
};

export type ConditionContext = {
  pair: string;
  now: Date;
  /** M5 candles for the pair (most recent last) — drives ATR, ADX, choppiness. */
  candles: Candle[];
  /** Current spread in price units, or null if unknown. */
  currentSpread: number | null;
  /** Typical (median) spread for the pair, or null if unknown. */
  typicalSpread: number | null;
  /** Historical ATR% for the SAME hour of day over the trailing ~20 days. */
  historicalAtrPercents: number[] | null;
  /** Upcoming HIGH-impact news for the pair. null = feed unavailable (UNKNOWN). */
  newsEvents: NewsEventInput[] | null;
  /** Whether the market is currently closed (weekend/holiday). */
  marketClosed: boolean;
  /** Age of the candle data in seconds. */
  dataFreshnessSeconds: number;
};

/** Map a volatility percentile (0-100) to a 0-100 goodness score. */
function volatilityGoodness(percentile: number): number {
  if (percentile < VOLATILITY.low) return 40; // too quiet — not GOOD
  if (percentile > VOLATILITY.high) return 40; // too extreme — not GOOD
  if (percentile >= VOLATILITY.idealMin && percentile <= VOLATILITY.idealMax) return 100;
  if (percentile < VOLATILITY.idealMin) {
    // 20 → 30 maps 40 → 100
    const t = (percentile - VOLATILITY.low) / (VOLATILITY.idealMin - VOLATILITY.low);
    return 40 + t * 60;
  }
  // 80 → 95 maps 100 → 40
  const t = (percentile - VOLATILITY.idealMax) / (VOLATILITY.high - VOLATILITY.idealMax);
  return 100 - t * 60;
}

function sessionNote(session: ScoringSession): string {
  switch (session) {
    case "LONDON_NY_OVERLAP":
      return "London and New York overlap — typically the most active window.";
    case "LONDON":
      return "London session — typically active with higher volume.";
    case "NEW_YORK":
      return "New York session — typically active around US data releases.";
    case "ASIAN":
      return "Asian session — often quieter and more range-bound.";
    case "OFF_HOURS":
    default:
      return "Outside major sessions — typically thinner liquidity.";
  }
}

/**
 * Compute the 0-100 market-condition score, rating, factors, and reasons for
 * a pair at a point in time. Pure + deterministic for fixed input data.
 *
 * Forced-AVOID rules (fire regardless of score):
 *   - high-impact news within 15 minutes,
 *   - spread more than 3x typical,
 *   - data older than 3 minutes,
 *   - market closed.
 *
 * Additionally, volatility below the 20th or above the 95th percentile can
 * never be rated GOOD (capped to CAUTION).
 */
export function conditionScore(ctx: ConditionContext): ConditionScore {
  const reasons: string[] = [];
  const factors: ConditionFactor[] = [];
  const forcedAvoidReasons: string[] = [];
  const notGoodReasons: string[] = [];

  // ── Volatility factor ────────────────────────────────────────────────────
  const lastClose = ctx.candles.length > 0 ? ctx.candles[ctx.candles.length - 1].close : null;
  const currentAtr = atr(ctx.candles);
  const currentAtrPercent =
    currentAtr != null && lastClose != null ? atrPercent(currentAtr, lastClose) : null;
  const vol = volatilityPercentile({
    currentAtrPercent,
    historicalAtrPercents: ctx.historicalAtrPercents,
  });

  let volatilityScore: number | null = null;
  let volatilityNote: string;
  if (!vol.known || vol.percentile == null) {
    if (currentAtrPercent != null) {
      volatilityScore = 70;
      volatilityNote = "Volatility estimate based on recent price action.";
    } else {
      volatilityNote = "Not enough volatility history for this hour yet.";
    }
  } else {
    volatilityScore = volatilityGoodness(vol.percentile);
    const pct = Math.round(vol.percentile);
    if (vol.percentile < VOLATILITY.low) {
      volatilityNote = `Volatility is unusually low (${pct}th percentile) — typically a quiet hour.`;
      notGoodReasons.push(
        `Volatility is unusually low for this hour, so price may not move enough.`,
      );
    } else if (vol.percentile > VOLATILITY.high) {
      volatilityNote = `Volatility is unusually high (${pct}th percentile) — conditions are erratic.`;
      notGoodReasons.push(
        `Volatility is unusually high for this hour, so price action is erratic.`,
      );
    } else {
      volatilityNote = `Volatility is near its typical range for this hour (${pct}th percentile).`;
    }
  }
  factors.push({
    key: "volatility",
    label: "Volatility",
    score: volatilityScore,
    weight: CONDITION_WEIGHTS.volatility,
    note: volatilityNote,
    percentile: vol.percentile,
  });

  // ── Trend / choppiness factor ────────────────────────────────────────────
  const trend = trendStrength(ctx.candles);
  let trendScore: number | null;
  let trendNote: string;
  if (!trend) {
    trendScore = null;
    trendNote = "Not enough candles to gauge trend strength yet.";
  } else if (trend.classification === "TRENDING") {
    trendScore = 100;
    trendNote = `Trending (ADX ${trend.adx.toFixed(1)}) — price is moving with direction.`;
  } else if (trend.classification === "CHOPPY") {
    trendScore = 30;
    trendNote = `Choppy (ADX ${trend.adx.toFixed(1)}, choppiness ${trend.choppiness.toFixed(
      0,
    )}) — price is erratic and range-bound.`;
    reasons.push("Price action is choppy — directional moves are unreliable.");
  } else {
    trendScore = 60;
    trendNote = `Ranging (ADX ${trend.adx.toFixed(1)}) — price is drifting without strong direction.`;
  }
  factors.push({
    key: "trend",
    label: "Trend",
    score: trendScore,
    weight: CONDITION_WEIGHTS.trend,
    note: trendNote,
  });

  // ── Spread factor ────────────────────────────────────────────────────────
  const spread = spreadScore(ctx.currentSpread, ctx.typicalSpread);
  const ratio = spreadRatio(ctx.currentSpread, ctx.typicalSpread);
  let spreadNote: string;
  if (spread == null) {
    spreadNote = "Spread data unavailable for this pair.";
  } else {
    spreadNote = `Spread is ${ratio!.toFixed(1)}x its typical level.`;
    if (ratio != null && ratio > FORCED_AVOID.spreadAvoidRatio) {
      forcedAvoidReasons.push(
        `Spread is more than ${FORCED_AVOID.spreadAvoidRatio}x its typical level — execution cost is elevated.`,
      );
    }
  }
  factors.push({
    key: "spread",
    label: "Spread",
    score: spread,
    weight: CONDITION_WEIGHTS.spread,
    note: spreadNote,
  });

  // ── Session factor ───────────────────────────────────────────────────────
  const session = sessionOf(ctx.now);
  const sessionScore = SESSION_SCORES[session];
  factors.push({
    key: "session",
    label: "Session",
    score: sessionScore,
    weight: CONDITION_WEIGHTS.session,
    note: sessionNote(session),
  });

  // ── News factor ──────────────────────────────────────────────────────────
  const news = newsProximity({
    pair: ctx.pair,
    now: ctx.now,
    events: ctx.newsEvents,
  });
  let newsScore: number | null;
  let newsNote: string;
  if (!news.known) {
    newsScore = null;
    newsNote = "News feed unavailable — high-impact events can't be checked.";
  } else if (news.minutesToNext == null) {
    newsScore = 100;
    newsNote = "No high-impact news expected for this pair soon.";
  } else if (news.minutesToNext <= NEWS.avoidMinutes) {
    newsScore = 0;
    newsNote = `High-impact news in ~${news.minutesToNext} min (${news.nextTitle}).`;
    forcedAvoidReasons.push(
      `High-impact news ("${news.nextTitle}") is due in about ${news.minutesToNext} minutes.`,
    );
  } else if (news.minutesToNext <= NEWS.cautionMinutes) {
    newsScore = 50;
    newsNote = `High-impact news in ~${news.minutesToNext} min (${news.nextTitle}).`;
    reasons.push(`High-impact news ("${news.nextTitle}") is due within the hour.`);
  } else {
    newsScore = 80;
    newsNote = `Next high-impact news in ~${news.minutesToNext} min.`;
  }
  factors.push({
    key: "news",
    label: "News",
    score: newsScore,
    weight: CONDITION_WEIGHTS.news,
    note: newsNote,
  });

  // ── Weighted score (UNKNOWN factors excluded, weights renormalized) ──────
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of factors) {
    if (f.score == null) continue;
    totalWeight += f.weight;
    weightedSum += f.score * f.weight;
  }
  const score = totalWeight === 0 ? 0 : Math.round(weightedSum / totalWeight);

  // ── Forced rules ─────────────────────────────────────────────────────────
  if (ctx.marketClosed) {
    forcedAvoidReasons.push("The market is closed right now.");
  }
  if (ctx.dataFreshnessSeconds > FORCED_AVOID.maxDataAgeSeconds) {
    forcedAvoidReasons.push(
      `Market data is ${Math.round(ctx.dataFreshnessSeconds)}s old (over ${
        FORCED_AVOID.maxDataAgeSeconds
      }s) — conditions may be stale.`,
    );
  }

  // ── Rating ───────────────────────────────────────────────────────────────
  let rating: ConditionRating;
  if (score >= RATING_BANDS.goodMin) rating = "GOOD";
  else if (score >= RATING_BANDS.cautionMin) rating = "CAUTION";
  else rating = "AVOID";

  // Volatility extremes can never be GOOD (cap to CAUTION).
  if (rating === "GOOD" && notGoodReasons.length > 0) rating = "CAUTION";

  // Forced rules override everything → AVOID.
  if (forcedAvoidReasons.length > 0) rating = "AVOID";

  // Compose plain-language reasons (forced first, then notable factors).
  const allReasons = [...forcedAvoidReasons, ...notGoodReasons, ...reasons];
  if (allReasons.length === 0) {
    allReasons.push(
      rating === "GOOD"
        ? "Conditions look typical for this pair right now."
        : "No single factor stands out; conditions are mixed.",
    );
  }

  return {
    score,
    rating,
    factors,
    reasons: allReasons,
    dataFreshnessSeconds: ctx.dataFreshnessSeconds,
  };
}
