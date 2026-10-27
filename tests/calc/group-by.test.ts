import { describe, it, expect } from "vitest";

import {
  groupBy,
  groupByAsset,
  groupByHourOfDay,
  groupByDayOfWeek,
  groupByStrategy,
  groupByEmotion,
  groupByDirection,
  groupAndAggregate,
  groupAndAggregateRaw,
} from "@/lib/calc/group-by";
import { normalizeTrades } from "@/lib/calc/normalize";
import { winRate, expectancyPerTrade } from "@/lib/calc/rates";
import type { TradeLike } from "@/lib/calc/types";

function makeTrade(opts: Partial<TradeLike> = {}): TradeLike {
  return {
    profitLoss: 100,
    result: "WIN",
    stake: 100,
    payoutPercent: 0.85,
    openedAt: new Date("2026-01-01T10:00:00Z"),
    asset: "EUR/USD",
    strategy: "Test",
    emotion: "CALM",
    direction: "CALL",
    ...opts,
  };
}

function norm(trades: TradeLike[]) {
  return normalizeTrades(trades);
}

describe("groupBy (generic)", () => {
  it("groups by extracted key", () => {
    const trades = norm([
      makeTrade({ asset: "EUR/USD" }),
      makeTrade({ asset: "EUR/USD" }),
      makeTrade({ asset: "GBP/USD" }),
    ]);
    const grouped = groupBy(trades, (t) => t.asset);
    expect(grouped.size).toBe(2);
    expect(grouped.get("EUR/USD")?.length).toBe(2);
    expect(grouped.get("GBP/USD")?.length).toBe(1);
  });
  it("empty trades → empty map", () => {
    expect(groupBy(norm([]), (t) => t.asset).size).toBe(0);
  });
});

describe("groupByAsset", () => {
  it("groups by asset symbol", () => {
    const trades = norm([
      makeTrade({ asset: "EUR/USD" }),
      makeTrade({ asset: "EUR/USD" }),
      makeTrade({ asset: "GBP/USD" }),
      makeTrade({ asset: "BTC/USD" }),
    ]);
    const grouped = groupByAsset(trades);
    expect(grouped.size).toBe(3);
    expect(grouped.get("EUR/USD")?.length).toBe(2);
    expect(grouped.get("GBP/USD")?.length).toBe(1);
    expect(grouped.get("BTC/USD")?.length).toBe(1);
  });
  it("unknown assets go to UNKNOWN group", () => {
    const trades = norm([makeTrade({ asset: undefined as unknown as string })]);
    expect(groupByAsset(trades).get("UNKNOWN")?.length).toBe(1);
  });
});

describe("groupByHourOfDay", () => {
  it("groups by UTC hour of openedAt", () => {
    const trades = norm([
      makeTrade({ openedAt: new Date("2026-01-01T10:30:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-01T10:45:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-01T14:00:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-01T22:00:00Z") }),
    ]);
    const grouped = groupByHourOfDay(trades);
    expect(grouped.size).toBe(3);
    expect(grouped.get("10")?.length).toBe(2);
    expect(grouped.get("14")?.length).toBe(1);
    expect(grouped.get("22")?.length).toBe(1);
  });
});

describe("groupByDayOfWeek", () => {
  it("groups by UTC day of week with short names", () => {
    // 2026-01-01 is a Thursday, 2026-01-02 is Friday, 2026-01-03 is Saturday
    const trades = norm([
      makeTrade({ openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-01T15:00:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-02T10:00:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-03T10:00:00Z") }),
      makeTrade({ openedAt: new Date("2026-01-04T10:00:00Z") }), // Sunday
    ]);
    const grouped = groupByDayOfWeek(trades);
    expect(grouped.size).toBe(4);
    expect(grouped.get("Thu")?.length).toBe(2);
    expect(grouped.get("Fri")?.length).toBe(1);
    expect(grouped.get("Sat")?.length).toBe(1);
    expect(grouped.get("Sun")?.length).toBe(1);
  });
});

describe("groupByStrategy", () => {
  it("groups by strategy name; null strategy → '—'", () => {
    const trades = norm([
      makeTrade({ strategy: "Bollinger Bounce" }),
      makeTrade({ strategy: "Bollinger Bounce" }),
      makeTrade({ strategy: "Trend Follow" }),
      makeTrade({ strategy: null }),
    ]);
    const grouped = groupByStrategy(trades);
    expect(grouped.size).toBe(3);
    expect(grouped.get("Bollinger Bounce")?.length).toBe(2);
    expect(grouped.get("Trend Follow")?.length).toBe(1);
    expect(grouped.get("—")?.length).toBe(1);
  });
});

describe("groupByEmotion", () => {
  it("groups by emotion enum; null → '—'", () => {
    const trades = norm([
      makeTrade({ emotion: "CALM" }),
      makeTrade({ emotion: "REVENGE" }),
      makeTrade({ emotion: "CALM" }),
      makeTrade({ emotion: null }),
    ]);
    const grouped = groupByEmotion(trades);
    expect(grouped.size).toBe(3);
    expect(grouped.get("CALM")?.length).toBe(2);
    expect(grouped.get("REVENGE")?.length).toBe(1);
    expect(grouped.get("—")?.length).toBe(1);
  });
});

describe("groupByDirection", () => {
  it("groups by CALL/PUT", () => {
    const trades = norm([
      makeTrade({ direction: "CALL" }),
      makeTrade({ direction: "PUT" }),
      makeTrade({ direction: "CALL" }),
    ]);
    const grouped = groupByDirection(trades);
    expect(grouped.size).toBe(2);
    expect(grouped.get("CALL")?.length).toBe(2);
    expect(grouped.get("PUT")?.length).toBe(1);
  });
});

describe("groupAndAggregate", () => {
  it("returns sorted group stats", () => {
    const trades = norm([
      // Bollinger: 2 wins, 1 loss → net = 85 - 100 + 85 = +70
      makeTrade({ strategy: "Bollinger", profitLoss: 85, result: "WIN", stake: 100 }),
      makeTrade({ strategy: "Bollinger", profitLoss: -100, result: "LOSS", stake: 100 }),
      makeTrade({ strategy: "Bollinger", profitLoss: 85, result: "WIN", stake: 100 }),
      // Trend: 1 win, 2 losses → net = 85 - 100 - 100 = -115
      makeTrade({ strategy: "Trend", profitLoss: 85, result: "WIN", stake: 100 }),
      makeTrade({ strategy: "Trend", profitLoss: -100, result: "LOSS", stake: 100 }),
      makeTrade({ strategy: "Trend", profitLoss: -100, result: "LOSS", stake: 100 }),
    ]);
    const out = groupAndAggregate(trades, groupByStrategy, { winRate, expectancyPerTrade });
    // Sorted by netProfit descending → Bollinger first (+70), Trend second (-115)
    expect(out[0].key).toBe("Bollinger");
    expect(out[0].count).toBe(3);
    expect(out[0].winRate).toBeCloseTo(2 / 3, 4);
    expect(out[0].netProfit).toBe(70);
    expect(out[1].key).toBe("Trend");
    expect(out[1].winRate).toBeCloseTo(1 / 3, 4);
    expect(out[1].netProfit).toBe(-115);
  });
  it("empty trades → empty array", () => {
    const out = groupAndAggregate(norm([]), groupByAsset, { winRate, expectancyPerTrade });
    expect(out).toEqual([]);
  });
});

describe("groupAndAggregateRaw", () => {
  it("accepts raw TradeLike[] (un-normalized)", () => {
    const rawTrades: TradeLike[] = [
      makeTrade({ asset: "EUR/USD", result: "OPEN" }), // dropped by normalizer
      makeTrade({ asset: "EUR/USD", profitLoss: 85, result: "WIN" }),
      makeTrade({ asset: "GBP/USD", profitLoss: -100, result: "LOSS" }),
    ];
    const out = groupAndAggregateRaw(rawTrades, groupByAsset, { winRate, expectancyPerTrade });
    // OPEN trade dropped → EUR/USD has 1 trade, GBP/USD has 1 trade
    expect(out.length).toBe(2);
    const eur = out.find((s) => s.key === "EUR/USD");
    expect(eur?.count).toBe(1);
    expect(eur?.winRate).toBe(1);
    expect(eur?.netProfit).toBe(85);
  });
});
