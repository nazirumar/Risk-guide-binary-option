import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hub test must NOT hit the live DB: stub the snapshot builder so the poll
// resolves on a microtask and fake timers stay deterministic.
vi.mock("@/server/lib/market-snapshot", () => ({
  MARKET_STALE_SECONDS: 180,
  buildMarketSnapshot: vi.fn(async () => ({
    serverTime: new Date().toISOString(),
    isStale: false,
    dataAgeSeconds: 1,
    provider: "test",
    providerLagSeconds: 1,
    providerLastError: null,
    marketClosed: false,
    pairs: [],
    nextNews: null,
  })),
}));

import {
  alertCooldownActive,
  buildMarketAlert,
  ratingChangedToActionable,
  MARKET_ALERT_COOLDOWN_MINUTES,
} from "@/lib/market/condition-alerts";
import {
  buildConditionContext,
  computeConditionMeta,
  computeDataFreshnessSeconds,
  median,
  quickAtr,
  sameHourAtrPercents,
  toCandleRows,
} from "@/lib/market/condition-input";

function candleAt(
  minute: number,
  overrides: Partial<Parameters<typeof toCandleRows>[0][number]> = {},
) {
  const time = new Date(Date.UTC(2026, 0, 5, 12, minute, 0));
  return {
    time,
    open: 1.1,
    high: 1.11,
    low: 1.09,
    close: 1.1,
    volume: 100,
    bid: 1.0999,
    ask: 1.1001,
    ...overrides,
  };
}

describe("condition-input: toCandleRows / median / quickAtr / sameHourAtrPercents", () => {
  it("normalizes null volume/bid/ask to undefined", () => {
    const rows = toCandleRows([candleAt(0, { volume: null, bid: null, ask: null })]);
    expect(rows[0].volume).toBeUndefined();
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });

  it("median handles even/odd lengths and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("quickAtr returns null for <2 candles and a real value otherwise", () => {
    expect(quickAtr(toCandleRows([candleAt(0)]))).toBeNull();
    const atr = quickAtr(toCandleRows([candleAt(0), candleAt(1)]));
    expect(atr).toBeGreaterThan(0);
  });

  it("sameHourAtrPercents emits one value per candle with a >0 close", () => {
    const rows = toCandleRows([candleAt(0), candleAt(1), candleAt(2)]);
    expect(sameHourAtrPercents(rows)).toHaveLength(2);
  });
});

describe("condition-input: computeDataFreshnessSeconds", () => {
  const now = new Date("2026-01-05T12:00:00Z");

  it("prefers the newest candle time", () => {
    const v = computeDataFreshnessSeconds(now, new Date("2026-01-05T11:59:30Z"), null);
    expect(v).toBeCloseTo(30, 5);
  });

  it("falls back to the provider's last-success time", () => {
    const v = computeDataFreshnessSeconds(now, null, new Date("2026-01-05T11:58:00Z"));
    expect(v).toBeCloseTo(120, 5);
  });

  it("returns Infinity when nothing is available (never assume fresh)", () => {
    expect(computeDataFreshnessSeconds(now, null, null)).toBe(Infinity);
  });
});

describe("condition-input: buildConditionContext + computeConditionMeta", () => {
  const now = new Date("2026-01-05T12:00:00Z"); // weekday, market open

  it("derives spread, freshness and passes news through", () => {
    const rows = [candleAt(0), candleAt(1), candleAt(2)];
    const ctx = buildConditionContext({
      pair: "EUR_USD",
      now,
      candleRows: rows,
      lastSuccessAt: null,
      newsRows: [{ currency: "USD", title: "NFP", impact: "HIGH", scheduledAt: now }],
      marketClosed: false,
    });
    expect(ctx.currentSpread).toBeCloseTo(0.0002, 6);
    expect(ctx.marketClosed).toBe(false);
    expect(ctx.newsEvents).toHaveLength(1);
    expect(Number.isFinite(ctx.dataFreshnessSeconds)).toBe(true);
  });

  it("keeps news null as UNKNOWN (feed unavailable)", () => {
    const ctx = buildConditionContext({
      pair: "EUR_USD",
      now,
      candleRows: [candleAt(0)],
      lastSuccessAt: null,
      newsRows: null,
      marketClosed: false,
    });
    expect(ctx.newsEvents).toBeNull();
  });

  it("computeConditionMeta reflects the volatility percentile + spread ratio", () => {
    const rows = [candleAt(0), candleAt(1), candleAt(2)];
    const ctx = buildConditionContext({
      pair: "EUR_USD",
      now,
      candleRows: rows,
      lastSuccessAt: null,
      newsRows: [],
      marketClosed: false,
    });
    const meta = computeConditionMeta(ctx, [{ key: "volatility", percentile: 42 }]);
    expect(meta.volatilityPercentile).toBe(42);
    expect(meta.spreadRatio).toBeGreaterThan(0);
    expect(meta.session).toBeTruthy();
  });
});

describe("condition-alerts", () => {
  it("only fires on a transition ending in GOOD or AVOID", () => {
    expect(ratingChangedToActionable("CAUTION", "GOOD")).toBe(true);
    expect(ratingChangedToActionable("GOOD", "AVOID")).toBe(true);
    expect(ratingChangedToActionable("GOOD", "GOOD")).toBe(false);
    expect(ratingChangedToActionable("CAUTION", "CAUTION")).toBe(false);
    expect(ratingChangedToActionable("GOOD", "CAUTION")).toBe(false); // not actionable
    expect(ratingChangedToActionable(null, "GOOD")).toBe(false); // no prior row
  });

  it("enforces the 30-minute cooldown and resets after it", () => {
    const now = new Date("2026-01-05T12:00:00Z");
    expect(alertCooldownActive(null, now)).toBe(false); // never alerted → allowed
    expect(alertCooldownActive(new Date("2026-01-05T11:45:00Z"), now)).toBe(true); // 15m ago
    expect(alertCooldownActive(new Date("2026-01-05T11:29:00Z"), now)).toBe(false); // 31m ago
    expect(
      alertCooldownActive(new Date("2026-01-05T11:45:00Z"), now, MARKET_ALERT_COOLDOWN_MINUTES),
    ).toBe(true);
  });

  it("builds descriptive, non-advisory copy for both ratings", () => {
    const good = buildMarketAlert("GOOD", "EUR_USD");
    const avoid = buildMarketAlert("AVOID", "EUR_USD");
    expect(good.title).toContain("EUR/USD");
    expect(avoid.title).toContain("AVOID");
    for (const copy of [good, avoid]) {
      expect(copy.body).toContain("not a trading signal");
      expect(copy.body).not.toMatch(/best time to trade|guaranteed|sure to/i);
    }
  });
});

describe("market-stream hub (ref-counting)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves many subscribers from one poll and stops when the last leaves", async () => {
    const { subscribeToMarketStream, marketStreamSubscriberCount } =
      await import("@/server/lib/market-stream");
    const { buildMarketSnapshot } = await import("@/server/lib/market-snapshot");
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = subscribeToMarketStream({ send: (p) => seenA.push(p) });
    const unsubB = subscribeToMarketStream({ send: (p) => seenB.push(p) });

    expect(marketStreamSubscriberCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenB.length).toBeGreaterThan(0);
    // ONE snapshot fetch serves BOTH subscribers (no per-client DB polling).
    expect(vi.mocked(buildMarketSnapshot)).toHaveBeenCalledTimes(1);

    unsubA();
    expect(marketStreamSubscriberCount()).toBe(1);
    unsubB();
    expect(marketStreamSubscriberCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(marketStreamSubscriberCount()).toBe(0);
  });
});
