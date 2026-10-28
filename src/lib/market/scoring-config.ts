/**
 * Phase 27 — Condition-scoring configuration.
 *
 * Every tunable weight + threshold lives here so the scoring model can be
 * adjusted without touching the computation code (PROJECT_RULES.md rule #8:
 * comments only where logic is non-obvious; the numbers here are self-
 * documenting via their names).
 *
 * The five factors and their starting weights sum to 100. UNKNOWN factors
 * (e.g. news data unavailable) are excluded and the remaining weights are
 * renormalized — we never assume "no news".
 */

export const CONDITION_WEIGHTS = {
  /** How active volatility is vs the pair's own history (weight 35). */
  volatility: 35,
  /** Trending vs choppy price action via ADX + choppiness (weight 20). */
  trend: 20,
  /** Current spread vs the pair's typical spread (weight 20). */
  spread: 20,
  /** Which market session is open (DST-aware) (weight 15). */
  session: 15,
  /** Proximity to the next high-impact news event (weight 10). */
  news: 10,
} as const;

export type ConditionWeightKey = keyof typeof CONDITION_WEIGHTS;

/** Volatility percentile bands (0-100) — see volatilityFactor(). */
export const VOLATILITY = {
  /** Under this percentile → "too low" → never GOOD. */
  low: 20,
  /** Over this percentile → "too high" → never GOOD. */
  high: 95,
  /** Ideal band [idealMin, idealMax] scores full marks. */
  idealMin: 30,
  idealMax: 80,
} as const;

/** Trend classification thresholds — see trendFactor(). */
export const TREND = {
  /** ADX >= this → TRENDING. */
  adxTrending: 25,
  /** Choppiness index >= this (and not trending) → CHOPPY. */
  choppinessChoppy: 61.8,
} as const;

/** Spread ratio thresholds — see spreadFactor(). */
export const SPREAD = {
  /** Ratio (current/typical) <= this → full score. */
  goodRatio: 1.5,
  /** Ratio > this forces AVOID (3x typical). */
  avoidRatio: 3,
} as const;

/** News proximity thresholds (minutes) — see newsFactor(). */
export const NEWS = {
  /** Minutes to next high-impact event that forces AVOID. */
  avoidMinutes: 15,
  /** Minutes to next event that downgrades to CAUTION. */
  cautionMinutes: 60,
} as const;

/** Forced-AVOID rules (override the weighted score). */
export const FORCED_AVOID = {
  /** Data older than this many seconds → AVOID (stale feed). */
  maxDataAgeSeconds: 180,
  /** Spread more than this multiple of typical → AVOID. */
  spreadAvoidRatio: SPREAD.avoidRatio,
  /** High-impact news within this many minutes → AVOID. */
  newsAvoidMinutes: NEWS.avoidMinutes,
} as const;

/** Rating bands applied to the weighted score (0-100) when no force fires. */
export const RATING_BANDS = {
  /** Score >= this → GOOD. */
  goodMin: 70,
  /** Score >= this (but < goodMin) → CAUTION; below → AVOID. */
  cautionMin: 45,
} as const;

/** Heatmap: minimum distinct days of candle data before a cell is trusted. */
export const HEATMAP_MIN_SAMPLE_DAYS = 10;

/** Default ATR period (matches the spec's period=14 default). */
export const DEFAULT_ATR_PERIOD = 14;
