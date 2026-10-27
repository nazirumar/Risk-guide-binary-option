/**
 * Pure statistical-reliability calc helpers for Phase 20 — Strategy
 * Validation.
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib/calc` as
 * pure, unit-tested functions. rule #1: money is Decimal — never Float,
 * though statistics use plain JS `number` since probabilities and z-scores
 * aren't money and need to match standard textbook reference values that
 * are floats. The monetary fields like `expectancyPerTrade` stay Decimal in
 * the actions layer.)
 *
 * Six exported pure functions + 2 helpers:
 *
 *   - `zScore(confidence)` — two-tailed z-score for a confidence level
 *     (e.g. 0.95 → 1.959964). Uses a lookup for the well-known standard
 *     levels and a Hastings approximation fallback for arbitrary levels.
 *
 *   - `wilsonInterval(wins, total, confidence=0.95)` — Wilson score
 *     interval for a binomial proportion. Returns { lower, upper, center,
 *     margin }. The interval shrinks as `total` grows — the central
 *     "win rate confidence band" chart uses this on the running tally.
 *
 *   - `isStatisticallyBetterThanBreakeven(wins, total, payoutPercent)` —
 *     one-sided z-test against the break-even win rate
 *     p_be = 1 / (1 + payout). Returns { z, pValue, verdict } in plain
 *     language. (Verdict is a separate field from reliabilityRating's
 *     verdict because this function is the single primitive; the rating
 *     combines sample-size tier + Wilson bounds to give the user-facing
 *     verdict.)
 *
 *   - `sampleSizeNeeded(targetEdge, confidence=0.95)` — worst-case sample
 *     size (using p=0.5) for a desired margin of error. Returns ceil.
 *
 *   - `reliabilityRating(wins, total, payoutPercent, confidence=0.95)` —
 *     combines sample-size tier (INSUFFICIENT <30 / LOW 30–99 / MEDIUM
 *     100–299 / HIGH 300+) with the Wilson-lower-beats-break-even check to
 *     produce { rating, verdict, winRate, breakEvenWinRate, wilsonLower,
 *     wilsonUpper, pValue }.
 *
 *   - `stdNormalTailProb(z)` — P(Z > z) for the standard normal, via the
 *     Abramowitz & Stegun 7.1.26 polynomial approximation.
 *
 * All math is pure + DB-free; tests assert exact reference values.
 */

// ─── z-score lookup + Hastings approximation ────────────────────────────────

/**
 * Two-tailed z-score for a confidence level. `confidence` is the probability
 * mass captured by the symmetric interval around the mean — e.g. 0.95 →
 * z = 1.959964 (the famous 1.96).
 *
 * Uses an exact lookup for the well-known standard confidence levels and a
 * Hastings rational approximation (accurate to ~3 decimals) for arbitrary
 * levels. Tests pin the exact values for 0.90 / 0.95 / 0.99.
 */
const KNOWN_Z_SCORES: ReadonlyMap<number, number> = new Map([
  [0.8, 1.281552],
  [0.85, 1.439531],
  [0.9, 1.644854],
  [0.95, 1.959964],
  [0.99, 2.575829],
  [0.999, 3.290527],
]);

export function zScore(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(`zScore: confidence must be a finite number in (0, 1); got ${confidence}`);
  }
  // Exact lookup for standard levels — pin to the textbook value so tests
  // don't drift across approximation changes.
  const exact = KNOWN_Z_SCORES.get(confidence);
  if (exact !== undefined) return exact;
  // Fallback: Hastings approximation (4-decimal accuracy).
  return invStdNormalCDF((1 + confidence) / 2);
}

/**
 * Hastings rational approximation for the inverse standard normal CDF.
 * Returns z such that P(Z ≤ z) = p, for 0 < p < 1. Accurate to about 3
 * decimals. Used only as a fallback for non-standard confidence levels.
 */
function invStdNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`invStdNormalCDF: p must be in (0, 1); got ${p}`);
  }
  // Symmetry: inv(0.05) = -inv(0.95). Use upper-tail form for stability.
  let sign = 1;
  let pp = p;
  if (p < 0.5) {
    sign = -1;
    pp = 1 - p;
  }
  // Hastings 7.1.23 polynomial coefficients (A&S 7.1.23 / Numerical Recipes).
  const t = Math.sqrt(-2 * Math.log(1 - pp));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  const z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
  return sign * z;
}

// ─── Standard normal tail probability (P(Z > z)) ─────────────────────────────

/**
 * Abramowitz & Stegun 7.1.26 polynomial approximation for the standard
 * normal tail probability P(Z > z). Accurate to about 7 decimals.
 *
 * For z = 0: tail = 0.5. For z = 1.96: tail ≈ 0.025 (i.e. 2.5% — the
 * upper-tail of the 95% CI). For z = 2.576: tail ≈ 0.005 (i.e. 0.5% — the
 * upper-tail of the 99% CI).
 */
export function stdNormalTailProb(z: number): number {
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  // Polynomial 7.1.26 — `poly` is the upper-tail probability for |z|.
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  // The polynomial multiplies the standard normal density at z to give the
  // tail probability for |z|. For z ≥ 0, P(Z > z) = tail(|z|). For z < 0,
  // P(Z > z) = 1 - tail(|z|) (i.e. the entire upper half minus the small
  // upper-tail probability at |z|).
  const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const tailAtAbsZ = density * poly;
  return z >= 0 ? tailAtAbsZ : 1 - tailAtAbsZ;
}

// ─── Wilson score interval ───────────────────────────────────────────────────

export type WilsonInterval = {
  /** Lower bound of the (confidence)-level two-sided Wilson interval, [0, 1]. */
  lower: number;
  /** Upper bound, [0, 1]. */
  upper: number;
  /** Center of the interval (the Wilson-adjusted point estimate). */
  center: number;
  /** Half-width of the interval. */
  margin: number;
  /** z-score used (for reference / debugging). */
  z: number;
};

/**
 * Wilson score interval for a binomial proportion.
 *
 * The Wilson interval is preferred over the naive `phat ± z * sqrt(p*(1-p)/n)`
 * because it has correct coverage near 0 and 1 — it doesn't extend below 0
 * for `wins = 0` and doesn't extend above 1 for `wins = total`. (The naive
 * Wald interval is notoriously bad at the edges; the Wilson interval is the
 * textbook-recommended alternative.)
 *
 * Formula (Wilson 1927):
 *
 *   let phat = wins / n, z² = zScore(confidence)²
 *   denominator = 1 + z²/n
 *   center = (phat + z²/(2n)) / denominator
 *   margin = (z / denominator) * sqrt(phat*(1-phat)/n + z²/(4n²))
 *   lower = max(0, center - margin)
 *   upper = min(1, center + margin)
 *
 * Reference values (well-known):
 *   wins=20, total=100, conf=0.95  → ~[0.1334, 0.2888]
 *   wins=50, total=100, conf=0.95  → ~[0.4019, 0.5943]
 *   wins=0,  total=10,  conf=0.95  → ~[0, 0.3076]  (zero-success edge)
 *   wins=100, total=100, conf=0.95 → ~[0.9690, 1]  (all-success edge)
 *
 * Edge cases:
 *   - total = 0 → returns {0, 0, 0, 0, z} (no data, no interval).
 *   - wins < 0 or wins > total → throws (precondition).
 *   - confidence outside (0, 1) → throws via zScore.
 */
export function wilsonInterval(
  wins: number,
  total: number,
  confidence: number = 0.95,
): WilsonInterval {
  if (!Number.isInteger(wins) || !Number.isInteger(total)) {
    throw new Error(`wilsonInterval: wins and total must be integers; got ${wins}/${total}`);
  }
  if (wins < 0 || total < 0 || wins > total) {
    throw new Error(`wilsonInterval: invalid wins/total; got wins=${wins}, total=${total}`);
  }
  if (total === 0) {
    return { lower: 0, upper: 0, center: 0, margin: 0, z: zScore(confidence) };
  }
  const z = zScore(confidence);
  const n = total;
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  // Clamp to [0, 1] — the Wilson formula shouldn't exceed these bounds in
  // theory but tiny float drift at the very edges can push it 1e-16 past.
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    center,
    margin,
    z,
  };
}

// ─── One-sided test against break-even ────────────────────────────────────────

export type StatisticalVerdict =
  "Likely profitable" | "Likely losing" | "Can't tell yet" | "Not enough data";

export type BreakEvenTest = {
  /** Break-even win rate p_be = 1 / (1 + payoutPercent). */
  breakEvenWinRate: number;
  /** Observed win rate phat = wins / total. */
  observedWinRate: number;
  /** One-sided z-statistic (positive ⇒ observed > break-even). */
  z: number;
  /** One-sided p-value: P(observed ≥ wins | H0: p = p_be). Small p ⇒ reject H0
   *  in favor of H1: p > p_be (strategy likely profitable). Large p (>0.95)
   *  ⇒ observed is significantly BELOW break-even (strategy likely losing). */
  pValue: number;
  /** Plain-language verdict. */
  verdict: StatisticalVerdict;
};

/**
 * One-sided binomial test against the break-even win rate.
 *
 * For a binary-options strategy:
 *   - Win: profit = stake * payoutPercent (e.g. 0.85 = 85%)
 *   - Loss: loss = stake (lose the full stake)
 *   - Break-even win rate = 1 / (1 + payoutPercent)  (e.g. 0.5405 for 85% payout)
 *
 * The one-sided test:
 *   H0: p ≤ p_be   (strategy is at or below break-even)
 *   H1: p > p_be   (strategy is above break-even — likely profitable)
 *
 * Uses the normal-approximation z-statistic:
 *   z = (phat - p_be) / sqrt(p_be * (1 - p_be) / n)
 *   pValue = P(Z > z | H0) = stdNormalTailProb(z)
 *
 * Verdict:
 *   - "Likely profitable"  if pValue < 0.05 AND total ≥ 30
 *   - "Likely losing"      if pValue > 0.95 AND total ≥ 30  (i.e. observed
 *     is significantly below break-even)
 *   - "Not enough data"    if total < 30
 *   - "Can't tell yet"     otherwise
 *
 * Examples (payoutPercent=0.85, p_be≈0.5405):
 *   wins=60, total=100 → phat=0.6, z≈1.193, pValue≈0.116 → "Can't tell yet"
 *   wins=70, total=100 → phat=0.7, z≈3.198, pValue≈0.00069 → "Likely profitable"
 *   wins=20, total=100 → phat=0.2, z≈-6.858, pValue≈1 → "Likely losing"
 *   wins=3,  total=10  → total<30 → "Not enough data"
 */
export function isStatisticallyBetterThanBreakeven(
  wins: number,
  total: number,
  payoutPercent: number,
): BreakEvenTest {
  if (!Number.isInteger(wins) || !Number.isInteger(total)) {
    throw new Error(
      `isStatisticallyBetterThanBreakeven: wins and total must be integers; got ${wins}/${total}`,
    );
  }
  if (wins < 0 || total < 0 || wins > total) {
    throw new Error(`isStatisticallyBetterThanBreakeven: invalid wins/total; got ${wins}/${total}`);
  }
  if (!Number.isFinite(payoutPercent) || payoutPercent <= 0) {
    throw new Error(
      `isStatisticallyBetterThanBreakeven: payoutPercent must be positive; got ${payoutPercent}`,
    );
  }
  // Break-even win rate for a binary-options strategy: 1 / (1 + payout).
  // At payout=0 → p_be=1 (must win 100% to break even — never any profit).
  // At payout=1 → p_be=0.5 (even-money bet, classic break-even).
  // At payout=0.85 → p_be=0.5405.
  const pBe = 1 / (1 + payoutPercent);
  if (total === 0) {
    return {
      breakEvenWinRate: pBe,
      observedWinRate: 0,
      z: 0,
      pValue: 0.5,
      verdict: "Not enough data",
    };
  }
  const phat = wins / total;
  if (total < 30) {
    return {
      breakEvenWinRate: pBe,
      observedWinRate: phat,
      z: 0,
      pValue: 0.5,
      verdict: "Not enough data",
    };
  }
  // Normal-approximation z-stat for the one-sided test under H0: p = p_be.
  // Using p_be (not phat) in the standard error gives a more conservative
  // small-sample test that matches the textbook one-sample z-test.
  const se = Math.sqrt((pBe * (1 - pBe)) / total);
  const z = se > 0 ? (phat - pBe) / se : 0;
  // One-sided p-value: P(Z > z | H0).  We use the standard-normal tail prob.
  const pValue = stdNormalTailProb(z);
  let verdict: StatisticalVerdict;
  if (pValue < 0.05) {
    verdict = "Likely profitable";
  } else if (pValue > 0.95) {
    // Equivalent to a one-sided test in the opposite direction rejecting H0
    // in favor of H1: p < p_be. (phat is significantly below break-even.)
    verdict = "Likely losing";
  } else {
    verdict = "Can't tell yet";
  }
  return { breakEvenWinRate: pBe, observedWinRate: phat, z, pValue, verdict };
}

// ─── Sample size needed ──────────────────────────────────────────────────────

/**
 * Worst-case sample size needed to estimate a binomial proportion to a
 * given margin of error (`targetEdge`) at the given confidence level.
 *
 * Uses the conservative p=0.5 (which maximizes the variance p*(1-p) and
 * hence maximizes the required sample size). The formula:
 *
 *   n = ceil(z² * 0.25 / targetEdge²)
 *
 * Examples:
 *   targetEdge=0.05, confidence=0.95 → 385 trades (textbook answer for
 *                                       "5% margin of error at 95% confidence")
 *   targetEdge=0.10, confidence=0.95 → 97 trades
 *   targetEdge=0.03, confidence=0.99 → 1844 trades
 *
 * Edge cases:
 *   - targetEdge ≤ 0 or ≥ 1 → throws (must be a sensible margin).
 *   - confidence outside (0, 1) → throws via zScore.
 */
export function sampleSizeNeeded(targetEdge: number, confidence: number = 0.95): number {
  if (!Number.isFinite(targetEdge) || targetEdge <= 0 || targetEdge >= 1) {
    throw new Error(
      `sampleSizeNeeded: targetEdge must be a finite number in (0, 1); got ${targetEdge}`,
    );
  }
  const z = zScore(confidence);
  const n = (z * z * 0.25) / (targetEdge * targetEdge);
  return Math.ceil(n);
}

// ─── Reliability rating + verdict ─────────────────────────────────────────────

export type ReliabilityRating = "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH";

export type ReliabilityAssessment = {
  /** Sample-size tier. */
  rating: ReliabilityRating;
  /** Plain-language verdict combining sample size + Wilson-vs-break-even. */
  verdict: StatisticalVerdict;
  /** Observed win rate (wins / total). */
  winRate: number;
  /** Break-even win rate for the given payout. */
  breakEvenWinRate: number;
  /** Wilson lower bound (at the given confidence). */
  wilsonLower: number;
  /** Wilson upper bound (at the given confidence). */
  wilsonUpper: number;
  /** One-sided p-value from the break-even test. */
  pValue: number;
  /** Confidence level used. */
  confidence: number;
};

/**
 * Combined reliability assessment for a strategy.
 *
 * The rating is a sample-size tier:
 *   - INSUFFICIENT: < 30 trades
 *   - LOW:          30–99 trades
 *   - MEDIUM:      100–299 trades
 *   - HIGH:        300+ trades
 *
 * The verdict is gated by the rating:
 *   - If INSUFFICIENT → "Not enough data" (regardless of observed win rate)
 *   - Otherwise compute the Wilson 95% (default) interval and compare:
 *     - lower > break-even → "Likely profitable"
 *     - upper < break-even → "Likely losing"
 *     - else → "Can't tell yet"
 *
 * The "lower bound beats break-even" check is the user-facing
 * statistical-significance gate. It's equivalent to the one-sided test
 * at the same confidence level (Wilson lower > p_be ⇔ z > z_{1-α/2}), so
 * the rating's verdict and the `isStatisticallyBetterThanBreakeven` verdict
 * agree on the "Likely profitable" case.
 *
 * The spec says "past results don't guarantee future results" — this function
 * is purely descriptive: it reports what the historical sample says, not a
 * prediction. The UI surfaces this distinction.
 */
export function reliabilityRating(
  wins: number,
  total: number,
  payoutPercent: number,
  confidence: number = 0.95,
): ReliabilityAssessment {
  if (!Number.isInteger(wins) || !Number.isInteger(total)) {
    throw new Error(`reliabilityRating: wins and total must be integers; got ${wins}/${total}`);
  }
  if (wins < 0 || total < 0 || wins > total) {
    throw new Error(`reliabilityRating: invalid wins/total; got ${wins}/${total}`);
  }
  if (!Number.isFinite(payoutPercent) || payoutPercent <= 0) {
    throw new Error(`reliabilityRating: payoutPercent must be positive; got ${payoutPercent}`);
  }
  const breakEvenWinRate = 1 / (1 + payoutPercent);
  const winRate = total === 0 ? 0 : wins / total;
  const wilson = wilsonInterval(wins, total, confidence);
  // Sample-size tier.
  let rating: ReliabilityRating;
  if (total < 30) rating = "INSUFFICIENT";
  else if (total < 100) rating = "LOW";
  else if (total < 300) rating = "MEDIUM";
  else rating = "HIGH";

  // Verdict — gated by the rating (INSUFFICIENT always says "not enough data").
  let verdict: StatisticalVerdict;
  if (rating === "INSUFFICIENT") {
    verdict = "Not enough data";
  } else if (wilson.lower > breakEvenWinRate) {
    verdict = "Likely profitable";
  } else if (wilson.upper < breakEvenWinRate) {
    verdict = "Likely losing";
  } else {
    verdict = "Can't tell yet";
  }

  // Compute the one-sided pValue for inclusion in the assessment. The
  // reliability-verdict and the break-even test verdict should agree on
  // the "Likely profitable" case (both are based on whether the lower
  // bound beats break-even at the same confidence level). We compute the
  // pValue via the z-statistic against p_be.
  const se = total > 0 ? Math.sqrt((breakEvenWinRate * (1 - breakEvenWinRate)) / total) : 0;
  const z = se > 0 ? (winRate - breakEvenWinRate) / se : 0;
  const pValue = total === 0 ? 0.5 : stdNormalTailProb(z);

  return {
    rating,
    verdict,
    winRate,
    breakEvenWinRate,
    wilsonLower: wilson.lower,
    wilsonUpper: wilson.upper,
    pValue,
    confidence,
  };
}
