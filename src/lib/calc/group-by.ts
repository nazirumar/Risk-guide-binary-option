/**
 * Phase 6 — Group-by helpers for analytics.
 *
 * Returns Map<groupKey, TradeLike[]> for each grouping dimension. Phase 9's
 * dashboard will call these + the rates module to compute per-group stats
 * (win rate by asset, expectancy by hour, etc.).
 *
 * Functions take raw TradeLike[] (un-normalized) so the caller doesn't have
 * to remember which normalization step to run — each helper normalizes
 * internally.
 */
import { normalizeTrades } from "./normalize";
import type { NormalizedTrade } from "./types";

/**
 * Generic groupBy — given a key extractor, returns a Map of group key →
 * trades in that group. The keys are strings; numeric dimensions (hour,
 * weekday) are stringified for ease of use in the UI.
 */
export function groupBy(
  trades: NormalizedTrade[],
  keyFn: (t: NormalizedTrade) => string,
): Map<string, NormalizedTrade[]> {
  const out = new Map<string, NormalizedTrade[]>();
  for (const t of trades) {
    const key = keyFn(t);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(t);
  }
  return out;
}

/** Group by asset symbol — e.g. "EUR/USD" → 12 trades. */
export function groupByAsset(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  return groupBy(trades, (t) => t.asset);
}

/**
 * Group by hour of day (UTC, 0..23). Useful for finding the trader's best
 * trading window — e.g. "you win 60% during London open but only 40% during
 * Asian session".
 *
 * Hour is the UTC hour of `openedAt`. Phase 9 will convert to the user's
 * timezone before grouping.
 */
export function groupByHourOfDay(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  return groupBy(trades, (t) => String(t.openedAt.getUTCHours()));
}

/**
 * Group by day of week (0=Sunday, 6=Saturday, using UTC).
 *
 * Most binary options traders don't trade weekends (no real-market data),
 * but OTC pairs trade 24/7 — this dimension surfaces the OTC-vs-real split.
 */
export function groupByDayOfWeek(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return groupBy(trades, (t) => DAYS[t.openedAt.getUTCDay()]);
}

/** Group by strategy name. Trades with no strategy land in the "—" group. */
export function groupByStrategy(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  return groupBy(trades, (t) => t.strategy ?? "—");
}

/** Group by emotion enum. Trades with no emotion land in the "—" group. */
export function groupByEmotion(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  return groupBy(trades, (t) => t.emotion ?? "—");
}

/** Group by direction — "CALL" or "PUT". */
export function groupByDirection(trades: NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  return groupBy(trades, (t) => t.direction);
}

// ─── Convenience: group-and-aggregate ────────────────────────────────────────

export type GroupStat = {
  key: string;
  count: number;
  winRate: number;
  netProfit: number;
  expectancyPerTrade: number;
};

/**
 * Convenience wrapper: takes raw TradeLike[], a grouping function, and the
 * rates module's `computeStats` (passed as a callback to avoid a circular
 * import). Returns an array of {key, count, winRate, netProfit, expectancy}
 * for dashboard rendering.
 *
 * Sort by netProfit descending so the dashboard shows the best groups first.
 */
export function groupAndAggregate(
  trades: NormalizedTrade[],
  groupFn: (trades: NormalizedTrade[]) => Map<string, NormalizedTrade[]>,
  rates: {
    winRate: (t: NormalizedTrade[]) => number;
    expectancyPerTrade: (t: NormalizedTrade[]) => number;
  },
): GroupStat[] {
  const groups = groupFn(trades);
  const out: GroupStat[] = [];
  for (const [key, groupTrades] of groups.entries()) {
    const np = groupTrades.reduce((acc, t) => acc + t.profitLoss, 0);
    out.push({
      key,
      count: groupTrades.length,
      winRate: rates.winRate(groupTrades),
      netProfit: np,
      expectancyPerTrade: rates.expectancyPerTrade(groupTrades),
    });
  }
  return out.sort((a, b) => b.netProfit - a.netProfit);
}

/**
 * Helper that accepts raw TradeLike[] (not normalized) and applies the
 * given groupFn. Convenience entry point so callers don't have to call
 * normalizeTrades themselves.
 */
export function groupAndAggregateRaw(
  rawTrades: import("./types").TradeLike[],
  groupFn: (trades: NormalizedTrade[]) => Map<string, NormalizedTrade[]>,
  rates: {
    winRate: (t: NormalizedTrade[]) => number;
    expectancyPerTrade: (t: NormalizedTrade[]) => number;
  },
): GroupStat[] {
  return groupAndAggregate(normalizeTrades(rawTrades), groupFn, rates);
}
