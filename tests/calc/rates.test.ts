import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import {
  countTrades,
  winRate,
  lossRate,
  tieRate,
  breakEvenWinRate,
  averagePayout,
  grossProfit,
  grossLoss,
  netProfit,
  averageWin,
  averageLoss,
  payoffRatio,
  profitFactor,
  expectancyPerTrade,
  expectancyInR,
  roi,
  computeStats,
} from "@/lib/calc/rates";
import { normalizeTrades } from "@/lib/calc/normalize";
import type { TradeLike } from "@/lib/calc/types";

/**
 * Phase 6 — tests for the rates / expectancy / profit factor / averages /
 * ROI module.
 *
 * Edge cases from the spec:
 *   - zero trades
 *   - all wins
 *   - all losses
 *   - payout 0
 *   - empty ranges
 */

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

describe("normalizeTrades", () => {
  it("drops OPEN trades", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 50 }),
      makeTrade({ result: "OPEN", profitLoss: 0 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
    ]);
    expect(trades.length).toBe(2);
    expect(trades[0].result).toBe("WIN");
    expect(trades[1].result).toBe("LOSS");
  });

  it("sorts chronologically by openedAt", () => {
    const trades = norm([
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-03T10:00:00Z") }),
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-02T10:00:00Z") }),
    ]);
    expect(trades[0].openedAt.getDate()).toBe(1);
    expect(trades[1].openedAt.getDate()).toBe(2);
    expect(trades[2].openedAt.getDate()).toBe(3);
  });

  it("accepts Decimal/string/number for money fields", () => {
    const trades = norm([
      makeTrade({
        profitLoss: new Decimal("100"),
        stake: new Decimal("100"),
        payoutPercent: new Decimal("0.85"),
      }),
      makeTrade({ profitLoss: "-50", stake: "50", payoutPercent: "0.90" }),
      makeTrade({ profitLoss: 0, stake: 200, payoutPercent: 0 }),
    ]);
    expect(trades[0].profitLoss).toBe(100);
    expect(trades[0].stake).toBe(100);
    expect(trades[1].profitLoss).toBe(-50);
    expect(trades[2].payoutPercent).toBe(0);
  });

  it("handles unparseable numbers (falls back to 0)", () => {
    const trades = norm([makeTrade({ profitLoss: "not-a-number" as unknown as number })]);
    expect(trades[0].profitLoss).toBe(0);
  });

  it("accepts Date object for openedAt (no string parsing)", () => {
    const d = new Date("2026-01-01T10:00:00Z");
    const trades = norm([makeTrade({ openedAt: d })]);
    expect(trades[0].openedAt).toBe(d);
  });

  it("falls back to max-date for unparseable string date", () => {
    const trades = norm([makeTrade({ openedAt: "not-a-date" as unknown as Date })]);
    // Date string that fails to parse → max date (far future)
    expect(trades[0].openedAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("falls back to max-date for null/undefined openedAt", () => {
    const trades = norm([
      makeTrade({ openedAt: null as unknown as Date }),
      makeTrade({ openedAt: undefined }),
    ]);
    expect(trades[0].openedAt.getTime()).toBeGreaterThan(Date.now());
    expect(trades[1].openedAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("countTrades", () => {
  it("zero trades → all zeros", () => {
    expect(countTrades(norm([]))).toEqual({ total: 0, wins: 0, losses: 0, ties: 0 });
  });
  it("all wins", () => {
    expect(countTrades(norm([makeTrade({ result: "WIN" }), makeTrade({ result: "WIN" })]))).toEqual(
      {
        total: 2,
        wins: 2,
        losses: 0,
        ties: 0,
      },
    );
  });
  it("all losses", () => {
    expect(
      countTrades(norm([makeTrade({ result: "LOSS" }), makeTrade({ result: "LOSS" })])),
    ).toEqual({
      total: 2,
      wins: 0,
      losses: 2,
      ties: 0,
    });
  });
  it("all ties", () => {
    expect(countTrades(norm([makeTrade({ result: "TIE" })]))).toEqual({
      total: 1,
      wins: 0,
      losses: 0,
      ties: 1,
    });
  });
  it("mixed", () => {
    const out = countTrades(
      norm([
        makeTrade({ result: "WIN" }),
        makeTrade({ result: "LOSS" }),
        makeTrade({ result: "WIN" }),
        makeTrade({ result: "TIE" }),
      ]),
    );
    expect(out).toEqual({ total: 4, wins: 2, losses: 1, ties: 1 });
  });
});

describe("winRate / lossRate / tieRate", () => {
  it("zero trades → 0 for all rates", () => {
    expect(winRate(norm([]))).toBe(0);
    expect(lossRate(norm([]))).toBe(0);
    expect(tieRate(norm([]))).toBe(0);
  });
  it("all wins → winRate=1", () => {
    expect(winRate(norm([makeTrade({ result: "WIN" }), makeTrade({ result: "WIN" })]))).toBe(1);
    expect(lossRate(norm([makeTrade({ result: "WIN" }), makeTrade({ result: "WIN" })]))).toBe(0);
  });
  it("all losses → lossRate=1", () => {
    expect(lossRate(norm([makeTrade({ result: "LOSS" }), makeTrade({ result: "LOSS" })]))).toBe(1);
    expect(winRate(norm([makeTrade({ result: "LOSS" }), makeTrade({ result: "LOSS" })]))).toBe(0);
  });
  it("mixed → fractions", () => {
    const trades = norm([
      makeTrade({ result: "WIN" }),
      makeTrade({ result: "LOSS" }),
      makeTrade({ result: "TIE" }),
      makeTrade({ result: "WIN" }),
    ]);
    expect(winRate(trades)).toBeCloseTo(0.5);
    expect(lossRate(trades)).toBeCloseTo(0.25);
    expect(tieRate(trades)).toBeCloseTo(0.25);
  });
});

describe("breakEvenWinRate", () => {
  it("85% payout → ~54.05%", () => {
    expect(breakEvenWinRate(0.85)).toBeCloseTo(0.54054, 4);
  });
  it("90% payout → ~52.63%", () => {
    expect(breakEvenWinRate(0.9)).toBeCloseTo(0.52632, 4);
  });
  it("100% payout → 50% (coin flip)", () => {
    expect(breakEvenWinRate(1)).toBe(0.5);
  });
  it("0% payout → 100% (must win every trade)", () => {
    expect(breakEvenWinRate(0)).toBe(1);
  });
  it("negative payout → 100% (impossible broker)", () => {
    expect(breakEvenWinRate(-0.5)).toBe(1);
  });
});

describe("averagePayout", () => {
  it("zero trades → 0", () => {
    expect(averagePayout(norm([]))).toBe(0);
  });
  it("averages payout across trades", () => {
    const trades = norm([makeTrade({ payoutPercent: 0.85 }), makeTrade({ payoutPercent: 0.9 })]);
    expect(averagePayout(trades)).toBeCloseTo(0.875);
  });
});

describe("grossProfit / grossLoss / netProfit", () => {
  it("zero trades → 0 for all sums", () => {
    expect(grossProfit(norm([]))).toBe(0);
    expect(grossLoss(norm([]))).toBe(0);
    expect(netProfit(norm([]))).toBe(0);
  });
  it("all wins → grossLoss=0, grossProfit=sum of P/L", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }),
      makeTrade({ result: "WIN", profitLoss: 170 }),
    ]);
    expect(grossProfit(trades)).toBe(255);
    expect(grossLoss(trades)).toBe(0);
    expect(netProfit(trades)).toBe(255);
  });
  it("all losses → grossProfit=0, grossLoss=abs(sum of P/L)", () => {
    const trades = norm([
      makeTrade({ result: "LOSS", profitLoss: -100 }),
      makeTrade({ result: "LOSS", profitLoss: -200 }),
    ]);
    expect(grossProfit(trades)).toBe(0);
    expect(grossLoss(trades)).toBe(300);
    expect(netProfit(trades)).toBe(-300);
  });
  it("mixed → sums both sides", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
      makeTrade({ result: "TIE", profitLoss: 0 }),
    ]);
    expect(grossProfit(trades)).toBe(85);
    expect(grossLoss(trades)).toBe(100);
    expect(netProfit(trades)).toBe(-15);
  });
  it("decimal precision preserved", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: "0.10" }),
      makeTrade({ result: "WIN", profitLoss: "0.20" }),
    ]);
    expect(grossProfit(trades)).toBeCloseTo(0.3, 10);
  });
});

describe("averageWin / averageLoss", () => {
  it("zero trades → 0 for both", () => {
    expect(averageWin(norm([]))).toBe(0);
    expect(averageLoss(norm([]))).toBe(0);
  });
  it("all wins → averageWin=mean, averageLoss=0", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }),
      makeTrade({ result: "WIN", profitLoss: 170 }),
    ]);
    expect(averageWin(trades)).toBe(127.5);
    expect(averageLoss(trades)).toBe(0);
  });
  it("all losses → averageLoss=mean, averageWin=0", () => {
    const trades = norm([
      makeTrade({ result: "LOSS", profitLoss: -100 }),
      makeTrade({ result: "LOSS", profitLoss: -200 }),
    ]);
    expect(averageLoss(trades)).toBe(150);
    expect(averageWin(trades)).toBe(0);
  });
  it("mixed → averages the winning and losing trades only", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }),
      makeTrade({ result: "WIN", profitLoss: 170 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
      makeTrade({ result: "TIE", profitLoss: 0 }),
    ]);
    expect(averageWin(trades)).toBe(127.5);
    expect(averageLoss(trades)).toBe(100);
  });
});

describe("payoffRatio", () => {
  it("zero trades → 0", () => {
    expect(payoffRatio(norm([]))).toBe(0);
  });
  it("all wins → Infinity (no losses)", () => {
    const trades = norm([makeTrade({ result: "WIN", profitLoss: 85 })]);
    expect(payoffRatio(trades)).toBe(Number.POSITIVE_INFINITY);
  });
  it("all losses → 0 (no wins)", () => {
    const trades = norm([makeTrade({ result: "LOSS", profitLoss: -100 })]);
    expect(payoffRatio(trades)).toBe(0);
  });
  it("mixed → avgWin / avgLoss", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85, stake: 100 }),
      makeTrade({ result: "LOSS", profitLoss: -100, stake: 100 }),
    ]);
    expect(payoffRatio(trades)).toBeCloseTo(0.85);
  });
});

describe("profitFactor", () => {
  it("zero trades → 0", () => {
    expect(profitFactor(norm([]))).toBe(0);
  });
  it("all wins → Infinity", () => {
    const trades = norm([makeTrade({ result: "WIN", profitLoss: 85 })]);
    expect(profitFactor(trades)).toBe(Number.POSITIVE_INFINITY);
  });
  it("all losses → 0", () => {
    const trades = norm([makeTrade({ result: "LOSS", profitLoss: -100 })]);
    expect(profitFactor(trades)).toBe(0);
  });
  it("break-even → 1", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 100 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
    ]);
    expect(profitFactor(trades)).toBe(1);
  });
  it("profitable → > 1", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 200 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
    ]);
    expect(profitFactor(trades)).toBe(2);
  });
  it("losing → < 1", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 50 }),
      makeTrade({ result: "LOSS", profitLoss: -100 }),
    ]);
    expect(profitFactor(trades)).toBe(0.5);
  });
});

describe("expectancyPerTrade", () => {
  it("zero trades → 0", () => {
    expect(expectancyPerTrade(norm([]))).toBe(0);
  });
  it("all wins → avgWin × winRate(1) - 0 = avgWin", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }),
      makeTrade({ result: "WIN", profitLoss: 170 }),
    ]);
    // avgWin = 127.5, winRate = 1, avgLoss = 0 → 127.5
    expect(expectancyPerTrade(trades)).toBe(127.5);
  });
  it("all losses → 0 - avgLoss × lossRate(1) = -avgLoss", () => {
    const trades = norm([
      makeTrade({ result: "LOSS", profitLoss: -100 }),
      makeTrade({ result: "LOSS", profitLoss: -200 }),
    ]);
    // avgLoss = 150, lossRate = 1 → -150
    expect(expectancyPerTrade(trades)).toBe(-150);
  });
  it("mixed → E = wr*avgWin - lr*avgLoss", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 85 }), // avgWin contribution
      makeTrade({ result: "LOSS", profitLoss: -100 }),
    ]);
    // winRate = 0.5, avgWin = 85, lossRate = 0.5, avgLoss = 100
    // E = 0.5*85 - 0.5*100 = 42.5 - 50 = -7.5
    expect(expectancyPerTrade(trades)).toBe(-7.5);
  });
  it("positive expectancy when avgWin > avgLoss", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 200 }),
      makeTrade({ result: "LOSS", profitLoss: -50 }),
    ]);
    // winRate = 0.5, avgWin = 200, lossRate = 0.5, avgLoss = 50
    // E = 0.5*200 - 0.5*50 = 100 - 25 = +75
    expect(expectancyPerTrade(trades)).toBe(75);
  });
});

describe("expectancyInR", () => {
  it("zero trades → 0", () => {
    expect(expectancyInR(norm([]))).toBe(0);
  });
  it("no losses (avgLoss=0) → 0", () => {
    const trades = norm([makeTrade({ result: "WIN", profitLoss: 85 })]);
    expect(expectancyInR(trades)).toBe(0);
  });
  it("positive expectancy in R", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 200 }), // avgWin = 200
      makeTrade({ result: "LOSS", profitLoss: -50 }), // avgLoss = 50
    ]);
    // E = 0.5*200 - 0.5*50 = 75. R = 75/50 = 1.5
    expect(expectancyInR(trades)).toBe(1.5);
  });
  it("negative expectancy in R", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 50 }),
      makeTrade({ result: "LOSS", profitLoss: -200 }),
    ]);
    // E = 0.5*50 - 0.5*200 = 25 - 100 = -75. R = -75/200 = -0.375
    expect(expectancyInR(trades)).toBe(-0.375);
  });
});

describe("roi", () => {
  it("zero trades → 0", () => {
    expect(roi(norm([]), 1000)).toBe(0);
  });
  it("zero starting balance → fall back to total stake", () => {
    const trades = norm([
      makeTrade({ result: "WIN", profitLoss: 100, stake: 100 }),
      makeTrade({ result: "WIN", profitLoss: 100, stake: 100 }),
    ]);
    // totalStake = 200, netProfit = 200, ROI = 1 (100%)
    expect(roi(trades, 0)).toBe(1);
  });
  it("positive ROI when profitable", () => {
    const trades = norm([makeTrade({ result: "WIN", profitLoss: 100, stake: 100 })]);
    // netProfit = 100, startingBalance = 1000, ROI = 0.1 (10%)
    expect(roi(trades, 1000)).toBe(0.1);
  });
  it("negative ROI when losing", () => {
    const trades = norm([makeTrade({ result: "LOSS", profitLoss: -500, stake: 500 })]);
    expect(roi(trades, 1000)).toBe(-0.5);
  });
});

describe("computeStats aggregator", () => {
  it("returns every rate-style stat in one pass", () => {
    const stats = computeStats([
      makeTrade({ result: "WIN", profitLoss: 85, stake: 100, payoutPercent: 0.85 }),
      makeTrade({ result: "LOSS", profitLoss: -100, stake: 100, payoutPercent: 0.85 }),
    ]);
    expect(stats.counts).toEqual({ total: 2, wins: 1, losses: 1, ties: 0 });
    expect(stats.winRate).toBe(0.5);
    expect(stats.lossRate).toBe(0.5);
    expect(stats.averagePayout).toBeCloseTo(0.85);
    expect(stats.breakEvenWinRate).toBeCloseTo(0.54054, 4);
    expect(stats.grossProfit).toBe(85);
    expect(stats.grossLoss).toBe(100);
    expect(stats.netProfit).toBe(-15);
    expect(stats.averageWin).toBe(85);
    expect(stats.averageLoss).toBe(100);
    expect(stats.profitFactor).toBe(0.85);
    expect(stats.expectancyPerTrade).toBe(-7.5);
    expect(stats.expectancyInR).toBe(-0.075);
  });
  it("zero trades → all stats 0 except profitFactor=0", () => {
    const stats = computeStats([]);
    expect(stats.counts.total).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.netProfit).toBe(0);
    expect(stats.profitFactor).toBe(0);
  });
});
