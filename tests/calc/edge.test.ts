/**
 * Phase 29 — pure-calc tests for `src/lib/calc/edge.ts` (personal edge).
 *
 * Covers:
 *   - volatilityBucket: boundary values (33/67), null/NaN/out-of-range → UNKNOWN.
 *   - groupEdge: seeded trades → sample size, win rate, expectancy, total P/L,
 *     avg payout; Wilson confidence range matches Phase 20's wilsonInterval;
 *     reliability tiers at the 30/100/300 boundaries; deterministic sorting.
 *   - groupEdgeWithDims: structured dimensions survive grouping.
 *   - bestAndWorst: groups under 30 trades are NEVER ranked; eligible-only
 *     selection; single-eligible edge case; needMoreTrades flag.
 *   - buildEdgeReport: all four groupings, insight wording (spec example
 *     sentence), "No data" buckets for missing snapshots, thin-sample copy,
 *     padded hour keys, zero-payout groups don't throw.
 *
 * Wording rule (PROJECT_RULES.md #11): assertions pin DESCRIPTIVE copy only —
 * sample sizes and ranges, no promises about future results.
 */
import { describe, it, expect } from "vitest";
import {
  VOL_BUCKET_BOUNDS,
  buildEdgeReport,
  bestAndWorst,
  groupEdge,
  groupEdgeWithDims,
  volatilityBucket,
  NEED_MORE_TRADES,
  EDGE_MIN_SAMPLE,
  type EdgeTradeInput,
} from "@/lib/calc/edge";
import { wilsonInterval } from "@/lib/calc/validation";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function trade(over: Partial<EdgeTradeInput> = {}): EdgeTradeInput {
  return {
    pair: "EUR/USD",
    session: "LONDON",
    hour: 10,
    rating: "GOOD",
    volatilityPercentile: 50,
    pnl: 10,
    win: true,
    payoutPercent: 0.85,
    ...over,
  };
}

/** n trades alternating win/loss with ±10 P/L, overridable per call. */
function seeded(n: number, over: Partial<EdgeTradeInput> = {}): EdgeTradeInput[] {
  return Array.from({ length: n }, (_, i) =>
    trade({ pnl: i % 2 === 0 ? 10 : -10, win: i % 2 === 0, ...over }),
  );
}

// ─── volatilityBucket ────────────────────────────────────────────────────────

describe("volatilityBucket — boundaries", () => {
  it("bounds are [0,33) LOW · [33,67) MEDIUM · [67,100] HIGH", () => {
    expect(VOL_BUCKET_BOUNDS).toEqual({ lowUpper: 33, highLower: 67 });
  });

  it("boundary values land in the right bucket", () => {
    expect(volatilityBucket(0)).toBe("LOW");
    expect(volatilityBucket(32.999)).toBe("LOW");
    expect(volatilityBucket(33)).toBe("MEDIUM");
    expect(volatilityBucket(66.999)).toBe("MEDIUM");
    expect(volatilityBucket(67)).toBe("HIGH");
    expect(volatilityBucket(100)).toBe("HIGH");
  });

  it("null / NaN / out-of-range → UNKNOWN (never guessed)", () => {
    expect(volatilityBucket(null)).toBe("UNKNOWN");
    expect(volatilityBucket(NaN)).toBe("UNKNOWN");
    expect(volatilityBucket(-1)).toBe("UNKNOWN");
    expect(volatilityBucket(100.5)).toBe("UNKNOWN");
    expect(volatilityBucket(Infinity)).toBe("UNKNOWN");
  });
});

// ─── groupEdge ───────────────────────────────────────────────────────────────

describe("groupEdge — sample stats + Phase 20 statistics", () => {
  it("computes trades, wins, win rate, expectancy, total P/L, avg payout", () => {
    const trades = [
      trade({ pnl: 85, win: true, payoutPercent: 0.85 }),
      trade({ pnl: -100, win: false, payoutPercent: 0.85 }),
      trade({ pnl: 85, win: true, payoutPercent: 0.85 }),
      trade({ pnl: -100, win: false, payoutPercent: 0.8 }),
    ];
    const [g] = groupEdge(trades, (t) => t.pair);
    expect(g.trades).toBe(4);
    expect(g.wins).toBe(2);
    expect(g.winRate).toBe(0.5);
    expect(g.totalPnl).toBe(85 - 100 + 85 - 100);
    expect(g.expectancy).toBe((-30) / 4);
    expect(g.avgPayout).toBeCloseTo((0.85 + 0.85 + 0.85 + 0.8) / 4, 10);
    expect(g.key).toBe("EUR/USD");
  });

  it("confidence range matches Phase 20 wilsonInterval exactly", () => {
    const trades = seeded(100, { pair: "GBP/USD" }); // 50 wins / 100
    const [g] = groupEdge(trades, (t) => t.pair);
    const w = wilsonInterval(50, 100, 0.95);
    expect(g.confidence).toBe(0.95);
    expect(g.winRateLow).toBeCloseTo(w.lower, 12);
    expect(g.winRateHigh).toBeCloseTo(w.upper, 12);
    expect(g.winRateLow).toBeLessThanOrEqual(g.winRate);
    expect(g.winRateHigh).toBeGreaterThanOrEqual(g.winRate);
  });

  it("reliability tier follows the sample-size boundaries (30/100/300)", () => {
    const tier = (n: number) => groupEdge(seeded(n), () => "k")[0].reliability;
    expect(tier(29)).toBe("INSUFFICIENT");
    expect(tier(30)).toBe("LOW");
    expect(tier(99)).toBe("LOW");
    expect(tier(100)).toBe("MEDIUM");
    expect(tier(299)).toBe("MEDIUM");
    expect(tier(300)).toBe("HIGH");
    expect(EDGE_MIN_SAMPLE).toBe(30);
  });

  it("INSUFFICIENT groups report 'Not enough data' verdict", () => {
    const [g] = groupEdge(seeded(10), () => "k");
    expect(g.reliability).toBe("INSUFFICIENT");
    expect(g.verdict).toBe("Not enough data");
  });

  it("zero-payout groups don't throw (payout fallback keeps the tier math defined)", () => {
    const trades = seeded(40, { payoutPercent: 0 });
    const [g] = groupEdge(trades, () => "k");
    expect(g.avgPayout).toBe(0);
    expect(g.reliability).toBe("LOW");
  });

  it("sorts by sample size desc, ties broken by key asc (deterministic)", () => {
    const trades = [
      ...seeded(5, { pair: "ZZZ/USD" }),
      ...seeded(10, { pair: "AAA/USD" }),
      ...seeded(10, { pair: "MMM/USD" }),
    ];
    const groups = groupEdge(trades, (t) => t.pair);
    expect(groups.map((g) => g.key)).toEqual(["AAA/USD", "MMM/USD", "ZZZ/USD"]);
  });

  it("groups by arbitrary key functions (session, hour, rating…)", () => {
    const trades = [...seeded(3, { session: "LONDON" }), ...seeded(2, { session: "ASIAN" })];
    const groups = groupEdge(trades, (t) => t.session);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "LONDON", trades: 3 });
    expect(groups[1]).toMatchObject({ key: "ASIAN", trades: 2 });
  });

  it("empty input → no groups (never a fake zero row)", () => {
    expect(groupEdge([], () => "k")).toEqual([]);
  });
});

// ─── groupEdgeWithDims ───────────────────────────────────────────────────────

describe("groupEdgeWithDims", () => {
  it("keeps structured dimensions alongside the group stats", () => {
    const trades = [
      ...seeded(4, { pair: "EUR/USD", session: "LONDON" }),
      ...seeded(1, { pair: "EUR/USD", session: "ASIAN" }),
    ];
    const entries = groupEdgeWithDims(
      trades,
      (t) => ({ pair: t.pair, session: t.session }),
      (d) => `${d.pair} · ${d.session}`,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].dims).toEqual({ pair: "EUR/USD", session: "LONDON" });
    expect(entries[0].group).toMatchObject({ key: "EUR/USD · LONDON", trades: 4 });
    expect(entries[1].group.trades).toBe(1);
  });
});

// ─── bestAndWorst ────────────────────────────────────────────────────────────

describe("bestAndWorst — 30-trade minimum enforced", () => {
  it("no groups at all → needMoreTrades with nulls", () => {
    const r = bestAndWorst([]);
    expect(r).toEqual({ best: null, worst: null, eligible: 0, needMoreTrades: true });
  });

  it("groups below the minimum are never ranked, even with huge win rates", () => {
    const thin = groupEdge(
      [trade({ pnl: 500, win: true }), trade({ pnl: 500, win: true })],
      (t) => t.pair,
    );
    const r = bestAndWorst(thin);
    expect(r.needMoreTrades).toBe(true);
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
  });

  it("ranks only eligible groups by expectancy (best = max, worst = min)", () => {
    const trades = [
      ...seeded(40, { pair: "WIN/USD", pnl: 0, win: false }), // expectancy 0
      ...seeded(35, {
        pair: "PROFIT/USD",
        win: true,
        pnl: 5,
      }), // expectancy +5
      ...seeded(32, { pair: "LOSS/USD", win: false, pnl: -3 }), // expectancy -3
      ...seeded(3, { pair: "NOISE/USD", pnl: -1000, win: false }), // thin, ignored
    ];
    const groups = groupEdge(trades, (t) => t.pair);
    const r = bestAndWorst(groups);
    expect(r.needMoreTrades).toBe(false);
    expect(r.eligible).toBe(3);
    expect(r.best?.key).toBe("PROFIT/USD");
    expect(r.worst?.key).toBe("LOSS/USD");
    expect(r.best?.expectancy).toBe(5);
    expect(r.worst?.expectancy).toBe(-3);
  });

  it("single eligible group → best and worst are that group", () => {
    const groups = groupEdge(seeded(30), (t) => t.pair);
    const r = bestAndWorst(groups);
    expect(r.eligible).toBe(1);
    expect(r.best?.key).toBe("EUR/USD");
    expect(r.worst?.key).toBe("EUR/USD");
    expect(r.needMoreTrades).toBe(false);
  });

  it("respects a custom minSample", () => {
    const groups = groupEdge(seeded(10), () => "k");
    const r = bestAndWorst(groups, 10);
    expect(r.eligible).toBe(1);
    expect(r.needMoreTrades).toBe(false);
  });
});

// ─── buildEdgeReport ─────────────────────────────────────────────────────────

describe("buildEdgeReport — groupings, insights, missing data", () => {
  it("empty trade list → zeroed report, no insights", () => {
    const r = buildEdgeReport([]);
    expect(r.totalTrades).toBe(0);
    expect(r.byPairSession).toEqual([]);
    expect(r.byRating).toEqual([]);
    expect(r.insights).toEqual([]);
    expect(r.tradesWithoutSnapshot).toBe(0);
  });

  it("builds all four groupings from one trade list", () => {
    const trades = [
      ...seeded(4, { pair: "EUR/USD", session: "LONDON", hour: 9, volatilityPercentile: 10 }),
      ...seeded(3, {
        pair: "EUR/USD",
        session: "NEW_YORK",
        hour: 15,
        volatilityPercentile: 80,
        rating: "CAUTION",
      }),
    ];
    const r = buildEdgeReport(trades);
    expect(r.totalTrades).toBe(7);
    expect(r.byPairSession).toHaveLength(2);
    expect(r.byPairSession[0].group.key).toBe("EUR/USD · LONDON");
    expect(r.byPairSession[0].pair).toBe("EUR/USD");
    expect(r.byPairSession[0].session).toBe("LONDON");
    expect(r.byPairHour.map((g) => g.key)).toEqual(["EUR/USD · 09:00", "EUR/USD · 15:00"]);
    expect(r.byRating.map((g) => g.key)).toEqual(["GOOD", "CAUTION"]);
    expect(r.byVolatility.map((g) => g.key)).toEqual(["LOW", "HIGH"]);
  });

  it("rating-less trades group under 'No data' and are counted", () => {
    const trades = [...seeded(5, { rating: null }), ...seeded(2, { rating: "AVOID" })];
    const r = buildEdgeReport(trades);
    expect(r.tradesWithoutSnapshot).toBe(5);
    expect(r.byRating.find((g) => g.key === "No data")?.trades).toBe(5);
    expect(r.byRating.find((g) => g.key === "AVOID")?.trades).toBe(2);
    const note = r.insights.find((i) => i.id === "no-snapshot");
    expect(note?.text).toContain("5 of 7 trades have no market snapshot");
    expect(note?.text).toContain('appear as "No data"');
  });

  it("spec example sentence for the top eligible pair × session", () => {
    // 68 wins / 112 trades in LONDON on EUR/USD.
    const trades = Array.from({ length: 112 }, (_, i) =>
      trade({ pnl: i < 68 ? 85 : -100, win: i < 68 }),
    );
    const r = buildEdgeReport(trades);
    const top = r.insights.find((i) => i.id === "top-pair-session");
    expect(top?.text).toMatch(
      /^Over 112 trades, your win rate in LONDON on EUR\/USD is \d+(\.\d+)?% \(range \d+(\.\d+)?–\d+(\.\d+)?%\)\.$/,
    );
  });

  it("thin top combination → 'need more trades' copy instead of a conclusion", () => {
    const r = buildEdgeReport(seeded(7));
    const top = r.insights.find((i) => i.id === "top-pair-session-thin");
    expect(top?.text).toContain("EUR/USD · LONDON with 7 trades");
    expect(top?.text).toContain(NEED_MORE_TRADES);
    // No best/worst conclusions from thin samples.
    expect(r.insights.find((i) => i.id === "best-combo")).toBeUndefined();
    expect(r.bestWorst.needMoreTrades).toBe(true);
  });

  it("best + worst combo insights only appear with ≥30-trade groups", () => {
    const trades = [
      ...seeded(30, { pair: "GOOD/USD", win: true, pnl: 4 }),
      ...seeded(30, { pair: "BAD/USD", win: false, pnl: -6, session: "ASIAN" }),
    ];
    const r = buildEdgeReport(trades);
    const best = r.insights.find((i) => i.id === "best-combo");
    const worst = r.insights.find((i) => i.id === "worst-combo");
    expect(best?.text).toContain("GOOD/USD");
    expect(worst?.text).toContain("BAD/USD");
  });

  it("rating insights: full sentence ≥30 trades, thin copy below", () => {
    const trades = [
      ...seeded(30, { rating: "GOOD" }),
      ...seeded(4, { rating: "AVOID", session: "ASIAN" }),
    ];
    const r = buildEdgeReport(trades);
    const full = r.insights.find((i) => i.id === "rating-GOOD");
    expect(full?.text).toMatch(
      /^Over 30 trades taken while the market rating was GOOD, your win rate was \d+(\.\d+)?% \(range .+\)\.$/,
    );
    const thin = r.insights.find((i) => i.id === "rating-AVOID-thin");
    expect(thin?.text).toContain('under a "AVOID" rating');
    expect(thin?.text).toContain(NEED_MORE_TRADES);
  });

  it("no promise language in any insight (descriptive only)", () => {
    const trades = [
      ...seeded(40, { pair: "EUR/USD", win: true, pnl: 5 }),
      ...seeded(35, { pair: "EUR/USD", session: "ASIAN", win: false, pnl: -5 }),
      ...seeded(12, { rating: null }),
    ];
    const r = buildEdgeReport(trades);
    expect(r.insights.length).toBeGreaterThan(0);
    const banned =
      /guarantee|guaranteed|will (win|profit|be profitable)|best time to trade|you should trade|expect to (win|earn)|profitable future/i;
    for (const i of r.insights) {
      expect(i.text).not.toMatch(banned);
      expect(i.text).not.toMatch(/\bsignal\b/i);
    }
  });

  it("hour keys are zero-padded for display", () => {
    const trades = [...seeded(2, { hour: 5 }), ...seeded(1, { hour: 17 })];
    const r = buildEdgeReport(trades);
    expect(r.byPairHour.map((g) => g.key).sort()).toEqual([
      "EUR/USD · 05:00",
      "EUR/USD · 17:00",
    ]);
  });

  it("volatility bucket grouping maps unknown to 'No data'", () => {
    const trades = [
      ...seeded(2, { volatilityPercentile: 50 }),
      ...seeded(1, { volatilityPercentile: null }),
    ];
    const r = buildEdgeReport(trades);
    expect(r.byVolatility.map((g) => g.key).sort()).toEqual(["MEDIUM", "No data"]);
  });
});
