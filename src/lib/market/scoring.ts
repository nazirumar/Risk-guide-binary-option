import Decimal from "decimal.js";

export type Candle = { time: Date; open: number; high: number; low: number; close: number; volume?: number };

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trs.push(tr);
  }
  let sum = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let val = sum / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

export function atrPercent(price: number, atrVal: number): number {
  if (price === 0) return 0;
  return (atrVal / price) * 100;
}

export function spreadScore(currentSpread: number, typicalSpread: number): number {
  if (typicalSpread <= 0) return 0;
  const ratio = currentSpread / typicalSpread;
  if (ratio <= 1) return 100;
  if (ratio >= 3) return 0;
  return Math.round(100 * (3 - ratio) / 2);
}

export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2) return 0;
  // Simplified ADX placeholder
  return 25;
}

export function choppiness(candles: Candle[], period = 14): number {
  if (candles.length < period) return 50;
  return 50;
}

export type Regime = "TRENDING" | "RANGING" | "CHOPPY";
export function classifyRegime(adxVal: number, chop: number): Regime {
  if (adxVal >= 25 && chop < 50) return "TRENDING";
  if (adxVal < 20 && chop >= 60) return "CHOPPY";
  return "RANGING";
}

export type Session = "ASIAN" | "LONDON" | "NEW_YORK" | "LONDON_NY_OVERLAP" | "OFF_HOURS";
export function sessionOf(timeUtc: Date): Session {
  const h = timeUtc.getUTCHours();
  if (h >= 0 && h < 7) return "ASIAN";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 12 && h < 16) return "LONDON_NY_OVERLAP";
  if (h >= 16 && h < 21) return "NEW_YORK";
  return "OFF_HOURS";
}

export function newsProximity(minutesToNextHighImpact: number | null): { factor: number; unknown: boolean } {
  if (minutesToNextHighImpact === null) return { factor: 0, unknown: true };
  if (minutesToNextHighImpact <= 15) return { factor: 0, unknown: false };
  if (minutesToNextHighImpact <= 60) return { factor: 50, unknown: false };
  return { factor: 100, unknown: false };
}

export type ConditionRating = "GOOD" | "CAUTION" | "AVOID";
export type ConditionResult = {
  score: number;
  rating: ConditionRating;
  factors: { name: string; value: number }[];
  reasons: string[];
  dataFreshnessSeconds: number;
};

export const SCORING_WEIGHTS = {
  volatility: 35,
  trendChop: 20,
  spread: 20,
  session: 15,
  news: 10,
};

export function conditionScore(input: {
  volatilityPercentile: number;
  adx: number;
  choppiness: number;
  spreadScore: number;
  session: Session;
  minutesToNextHighImpact: number | null;
  dataFreshnessSeconds: number;
  marketClosed: boolean;
}): ConditionResult {
  const reasons: string[] = [];
  const factors: { name: string; value: number }[] = [];

  // Forced AVOID
  if (input.marketClosed) {
    reasons.push("Market is closed.");
    return { score: 0, rating: "AVOID", factors, reasons, dataFreshnessSeconds: input.dataFreshnessSeconds };
  }
  if (input.dataFreshnessSeconds > 180) {
    reasons.push("Data is stale (older than 3 minutes).");
    return { score: 0, rating: "AVOID", factors, reasons, dataFreshnessSeconds: input.dataFreshnessSeconds };
  }
  if (input.minutesToNextHighImpact !== null && input.minutesToNextHighImpact <= 15) {
    reasons.push("High-impact news within 15 minutes.");
    return { score: 0, rating: "AVOID", factors, reasons, dataFreshnessSeconds: input.dataFreshnessSeconds };
  }
  if (input.spreadScore <= 0) {
    reasons.push("Spread is more than 3x typical.");
    return { score: 0, rating: "AVOID", factors, reasons, dataFreshnessSeconds: input.dataFreshnessSeconds };
  }

  // Volatility factor
  let volFactor = 100;
  if (input.volatilityPercentile < 20) { volFactor = 30; reasons.push("Volatility too low."); }
  else if (input.volatilityPercentile > 95) { volFactor = 30; reasons.push("Volatility too high."); }
  factors.push({ name: "volatility", value: volFactor });

  const regime = classifyRegime(input.adx, input.choppiness);
  const trendFactor = regime === "TRENDING" ? 100 : regime === "RANGING" ? 60 : 30;
  factors.push({ name: "trendChop", value: trendFactor });

  factors.push({ name: "spread", value: input.spreadScore });

  const sessionFactor = input.session === "LONDON_NY_OVERLAP" ? 100 : input.session === "LONDON" || input.session === "NEW_YORK" ? 80 : input.session === "ASIAN" ? 50 : 20;
  factors.push({ name: "session", value: sessionFactor });

  const news = newsProximity(input.minutesToNextHighImpact);
  factors.push({ name: "news", value: news.unknown ? 50 : news.factor });

  const score = Math.round(
    (volFactor * SCORING_WEIGHTS.volatility +
      trendFactor * SCORING_WEIGHTS.trendChop +
      input.spreadScore * SCORING_WEIGHTS.spread +
      sessionFactor * SCORING_WEIGHTS.session +
      (news.unknown ? 50 : news.factor) * SCORING_WEIGHTS.news) /
      100,
  );

  const rating: ConditionRating = score >= 70 ? "GOOD" : score >= 40 ? "CAUTION" : "AVOID";
  return { score, rating, factors, reasons, dataFreshnessSeconds: input.dataFreshnessSeconds };
}
