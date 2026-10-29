/**
 * Phase 29 — Personal edge analytics (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: pure calc in `/src/lib`, rule #11: wording is
 * descriptive — this module reports what a historical sample says, never what
 * will happen. No "best time to trade", no signals, no promises; the UI
 * surfaces the same distinction next to every table.)
 *
 * Reuses the Phase 20 statistics from `./validation` so every number on the
 * Market Edge page agrees with the rest of the app:
 *   - `wilsonInterval(wins, total, confidence)` → the confidence range.
 *   - `reliabilityRating(wins, total, payout)`  → sample-size tier
 *     (INSUFFICIENT < 30, LOW 30–99, MEDIUM 100–299, HIGH 300+).
 *
 * Every group carries its sample size + reliability. Under `EDGE_MIN_SAMPLE`
 * (30) trades a group is INSUFFICIENT and must not be used to draw a
 * conclusion — the UI shows "need more trades" instead, and
 * `bestAndWorstCombos` refuses to rank such groups at all.
 */
import {
  wilsonInterval,
  reliabilityRating,
  type ReliabilityRating,
  type StatisticalVerdict,
} from "./validation";

/** Below this many trades a group is INSUFFICIENT — no conclusions drawn. */
export const EDGE_MIN_SAMPLE = 30;
/** Confidence level for every range on the Market Edge page. */
export const EDGE_CONFIDENCE = 0.95;
/** "Need more trades" copy — one source of truth for the wording. */
export const NEED_MORE_TRADES = `Need more trades — at least ${EDGE_MIN_SAMPLE} to describe a pattern.`;

/** One closed trade, flattened for grouping. Display-only numbers. */
export type EdgeTradeInput = {
  /** Asset exactly as stored on the trade ("EUR/USD"). */
  pair: string;
  /** Session at open (snapshot when present, else classifyTradeBySession). */
  session: string;
  /** Hour of open in the user's timezone, 0–23. */
  hour: number;
  /** GOOD/CAUTION/AVOID snapshot; null when no market data was available. */
  rating: string | null;
  /** 0–100 percentile of volatility at open; null when unknown. */
  volatilityPercentile: number | null;
  /** P/L in account currency (plain number — analytics display, not accounting). */
  pnl: number;
  win: boolean;
  /** Payout fraction of the trade, 0–1 (feeds the break-even in reliability). */
  payoutPercent: number;
};

export type VolBucket = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

/** Volatility percentile (0–100) bucket bounds. Inclusive lower bound:
 *  [0, 33) LOW · [33, 67) MEDIUM · [67, 100] HIGH. */
export const VOL_BUCKET_BOUNDS = { lowUpper: 33, highLower: 67 } as const;

/**
 * Bucket a 0–100 volatility percentile into LOW/MEDIUM/HIGH. null (unknown),
 * NaN and out-of-range values → UNKNOWN — we never guess a bucket.
 */
export function volatilityBucket(pct: number | null): VolBucket {
  if (pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) return "UNKNOWN";
  if (pct < VOL_BUCKET_BOUNDS.lowUpper) return "LOW";
  if (pct < VOL_BUCKET_BOUNDS.highLower) return "MEDIUM";
  return "HIGH";
}

/** One grouped slice: sample size, win rate + confidence range, expectancy,
 *  and the Phase 20 reliability tier. */
export type EdgeGroup = {
  /** Display-ready key ("EUR/USD · LONDON"). */
  key: string;
  trades: number;
  wins: number;
  /** wins / trades (0 when empty). */
  winRate: number;
  /** Wilson 95% lower bound (0 when empty). */
  winRateLow: number;
  /** Wilson 95% upper bound (0 when empty). */
  winRateHigh: number;
  confidence: number;
  /** P/L per trade in the group (0 when empty). */
  expectancy: number;
  /** Net P/L of the group. */
  totalPnl: number;
  /** Average payout fraction (0–1) of the group's trades. */
  avgPayout: number;
  /** Phase 20 sample-size tier: INSUFFICIENT below 30 trades. */
  reliability: ReliabilityRating;
  /** Phase 20 verdict vs the group's break-even ("Not enough data" < 30). */
  verdict: StatisticalVerdict;
};

/** Build one EdgeGroup from a set of raw trades sharing a key. */
function toGroup(key: string, trades: EdgeTradeInput[]): EdgeGroup {
  const n = trades.length;
  const wins = trades.reduce((acc, t) => (t.win ? acc + 1 : acc), 0);
  const totalPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const avgPayoutRaw =
    n === 0 ? 0 : trades.reduce((acc, t) => acc + t.payoutPercent, 0) / n;
  // reliabilityRating needs a positive payout for break-even. Groups with a
  // zero/invalid average (bad rows) fall back to 0.8 so the tier math stays
  // defined — the tier itself only depends on sample size.
  const payoutForRating = avgPayoutRaw > 0 ? avgPayoutRaw : 0.8;
  const assessment = reliabilityRating(wins, n, payoutForRating, EDGE_CONFIDENCE);
  const wilson = wilsonInterval(wins, n, EDGE_CONFIDENCE);
  return {
    key,
    trades: n,
    wins,
    winRate: n === 0 ? 0 : wins / n,
    winRateLow: wilson.lower,
    winRateHigh: wilson.upper,
    confidence: EDGE_CONFIDENCE,
    expectancy: n === 0 ? 0 : totalPnl / n,
    totalPnl,
    avgPayout: avgPayoutRaw,
    reliability: assessment.rating,
    verdict: assessment.verdict,
  };
}

/**
 * Group trades by a display key. Sorted by sample size (desc), then by key so
 * ties are deterministic. Empty groups are impossible (only existing keys emit).
 */
export function groupEdge(
  trades: EdgeTradeInput[],
  keyFn: (t: EdgeTradeInput) => string,
): EdgeGroup[] {
  const map = new Map<string, EdgeTradeInput[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  return Array.from(map.entries())
    .map(([key, ts]) => toGroup(key, ts))
    .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

/** Group + keep the structured dimensions (for insights that need the parts). */
export function groupEdgeWithDims<D>(
  trades: EdgeTradeInput[],
  dimOf: (t: EdgeTradeInput) => D,
  keyOf: (d: D) => string,
): Array<{ dims: D; group: EdgeGroup }> {
  const map = new Map<string, { dims: D; trades: EdgeTradeInput[] }>();
  for (const t of trades) {
    const dims = dimOf(t);
    const key = keyOf(dims);
    const entry = map.get(key);
    if (entry) entry.trades.push(t);
    else map.set(key, { dims, trades: [t] });
  }
  return Array.from(map.values())
    .map((e) => ({ dims: e.dims, group: toGroup(keyOf(e.dims), e.trades) }))
    .sort((a, b) => b.group.trades - a.group.trades || a.group.key.localeCompare(b.group.key));
}

export type BestWorst = {
  best: EdgeGroup | null;
  worst: EdgeGroup | null;
  /** How many groups had ≥ EDGE_MIN_SAMPLE trades (eligible to rank). */
  eligible: number;
  /** True when NO group reached the minimum — UI shows "need more trades". */
  needMoreTrades: boolean;
};

/**
 * Strongest/weakest combinations by expectancy, restricted to groups with at
 * least `EDGE_MIN_SAMPLE` trades. Groups below the minimum are never ranked —
 * a 3-trade "best" would be noise dressed as a pattern.
 */
export function bestAndWorst(groups: EdgeGroup[], minSample: number = EDGE_MIN_SAMPLE): BestWorst {
  const eligible = groups.filter((g) => g.trades >= minSample);
  if (eligible.length === 0) {
    return { best: null, worst: null, eligible: 0, needMoreTrades: true };
  }
  const byExpectancy = [...eligible].sort(
    (a, b) => b.expectancy - a.expectancy || b.winRate - a.winRate || b.trades - a.trades,
  );
  return {
    best: byExpectancy[0],
    worst: byExpectancy[byExpectancy.length - 1],
    eligible: eligible.length,
    needMoreTrades: false,
  };
}

export type EdgeInsight = {
  /** Stable key for React lists / testids. */
  id: string;
  text: string;
};

export type EdgeReport = {
  totalTrades: number;
  /** pair × session (the heatmap + main table). */
  byPairSession: Array<{ pair: string; session: string; group: EdgeGroup }>;
  /** pair × hour-of-open (user TZ). */
  byPairHour: EdgeGroup[];
  /** GOOD vs CAUTION vs AVOID vs "No data". */
  byRating: EdgeGroup[];
  /** LOW / MEDIUM / HIGH / UNKNOWN volatility buckets. */
  byVolatility: EdgeGroup[];
  bestWorst: BestWorst;
  /** Trades without a market snapshot (pre-Phase 29 / no market data). */
  tradesWithoutSnapshot: number;
  /** Plain-language, descriptive observations about the sample. */
  insights: EdgeInsight[];
};

const pad2 = (h: number) => String(h).padStart(2, "0");

const pct1 = (x: number) => `${Math.round(x * 1000) / 10}`;

/**
 * Build the full Market Edge report from the user's closed trades. Pure —
 * the caller loads + filters rows (userId-scoped) and passes them in.
 *
 * All insights are descriptive past-tense observations with sample sizes and
 * ranges; nothing here predicts future results (rule #11).
 */
export function buildEdgeReport(trades: EdgeTradeInput[]): EdgeReport {
  const byPairSessionRaw = groupEdgeWithDims(
    trades,
    (t) => ({ pair: t.pair, session: t.session }),
    (d) => `${d.pair} · ${d.session}`,
  );
  const byRating = groupEdge(trades, (t) => t.rating ?? "No data");
  const byVolatility = groupEdge(trades, (t) => {
    const b = volatilityBucket(t.volatilityPercentile);
    return b === "UNKNOWN" ? "No data" : b;
  });
  const byPairHour = groupEdge(trades, (t) => `${t.pair} · ${pad2(t.hour)}:00`);
  const bestWorst = bestAndWorst(byPairSessionRaw.map((e) => e.group));
  const tradesWithoutSnapshot = trades.filter((t) => t.rating == null).length;

  const insights: EdgeInsight[] = [];

  // 1. The most-traded pair×session with enough data — the spec's example
  //    sentence ("Over 112 trades, your win rate in LONDON on EUR_USD …").
  const topEligible = byPairSessionRaw.find((e) => e.group.trades >= EDGE_MIN_SAMPLE);
  if (topEligible) {
    const g = topEligible.group;
    insights.push({
      id: "top-pair-session",
      text: `Over ${g.trades} trades, your win rate in ${topEligible.dims.session} on ${topEligible.dims.pair} is ${pct1(
        g.winRate,
      )}% (range ${pct1(g.winRateLow)}–${pct1(g.winRateHigh)}%).`,
    });
  } else if (byPairSessionRaw.length > 0) {
    const g = byPairSessionRaw[0].group;
    insights.push({
      id: "top-pair-session-thin",
      text: `Your most-traded combination is ${g.key} with ${g.trades} trades — ${NEED_MORE_TRADES}`,
    });
  }

  // 2. Best/worst combinations (≥30 trades only — bestAndWorst enforces it).
  if (!bestWorst.needMoreTrades && bestWorst.best) {
    insights.push({
      id: "best-combo",
      text: `Strongest historical combination by expectancy: ${bestWorst.best.key} (${bestWorst.best.trades} trades, ${bestWorst.best.expectancy >= 0 ? "+" : ""}${bestWorst.best.expectancy.toFixed(2)} per trade).`,
    });
  }
  if (!bestWorst.needMoreTrades && bestWorst.worst && bestWorst.worst.key !== bestWorst.best?.key) {
    insights.push({
      id: "worst-combo",
      text: `Weakest historical combination by expectancy: ${bestWorst.worst.key} (${bestWorst.worst.trades} trades, ${bestWorst.worst.expectancy >= 0 ? "+" : ""}${bestWorst.worst.expectancy.toFixed(2)} per trade).`,
    });
  }

  // 3. Rating comparison, one sentence per rating with a real sample.
  for (const rating of ["GOOD", "CAUTION", "AVOID"] as const) {
    const g = byRating.find((x) => x.key === rating);
    if (!g) continue;
    if (g.trades >= EDGE_MIN_SAMPLE) {
      insights.push({
        id: `rating-${rating}`,
        text: `Over ${g.trades} trades taken while the market rating was ${rating}, your win rate was ${pct1(
          g.winRate,
        )}% (range ${pct1(g.winRateLow)}–${pct1(g.winRateHigh)}%).`,
      });
    } else {
      insights.push({
        id: `rating-${rating}-thin`,
        text: `You have ${g.trades} trade${g.trades === 1 ? "" : "s"} under a "${rating}" rating — ${NEED_MORE_TRADES}`,
      });
    }
  }

  // 4. Snapshot coverage note (honesty about missing data).
  if (tradesWithoutSnapshot > 0) {
    insights.push({
      id: "no-snapshot",
      text: `${tradesWithoutSnapshot} of ${trades.length} trades have no market snapshot (recorded before live conditions existed, or no market data for that instrument). They appear as "No data" and are excluded from rating comparisons.`,
    });
  }

  return {
    totalTrades: trades.length,
    byPairSession: byPairSessionRaw.map((e) => ({
      pair: e.dims.pair,
      session: e.dims.session,
      group: e.group,
    })),
    byPairHour,
    byRating,
    byVolatility,
    bestWorst,
    tradesWithoutSnapshot,
    insights,
  };
}
