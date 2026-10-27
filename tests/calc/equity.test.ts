import { describe, it, expect } from "vitest";

import {
  equityCurve,
  drawdownStats,
  recoveryFactor,
  computeStreaks,
  computeEquityStats,
} from "@/lib/calc/equity";
import { normalizeTrades } from "@/lib/calc/normalize";
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

describe("equityCurve", () => {
  it("zero trades → [startBalance]", () => {
    expect(equityCurve(norm([]), 1000)).toEqual([1000]);
  });

  it("returns startBalance + N running balances", () => {
    const trades = norm([
      makeTrade({ profitLoss: 100, openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ profitLoss: -50, openedAt: new Date("2026-01-02T10:00:00Z") }),
      makeTrade({ profitLoss: 200, openedAt: new Date("2026-01-03T10:00:00Z") }),
    ]);
    const curve = equityCurve(trades, 1000);
    // [1000, 1100, 1050, 1250]
    expect(curve).toEqual([1000, 1100, 1050, 1250]);
    expect(curve.length).toBe(4); // start + N
  });

  it("all wins → monotonically increasing curve", () => {
    const trades = norm([
      makeTrade({ profitLoss: 85, result: "WIN" }),
      makeTrade({ profitLoss: 170, result: "WIN" }),
      makeTrade({ profitLoss: 50, result: "WIN" }),
    ]);
    const curve = equityCurve(trades, 1000);
    expect(curve).toEqual([1000, 1085, 1255, 1305]);
    // Verify monotonic increase
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    }
  });

  it("all losses → monotonically decreasing curve", () => {
    const trades = norm([
      makeTrade({ profitLoss: -100, result: "LOSS" }),
      makeTrade({ profitLoss: -200, result: "LOSS" }),
    ]);
    const curve = equityCurve(trades, 1000);
    expect(curve).toEqual([1000, 900, 700]);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeLessThan(curve[i - 1]);
    }
  });

  it("decimal precision preserved", () => {
    const trades = norm([makeTrade({ profitLoss: 0.1 }), makeTrade({ profitLoss: 0.2 })]);
    const curve = equityCurve(trades, 0);
    expect(curve[1]).toBeCloseTo(0.1, 10);
    expect(curve[2]).toBeCloseTo(0.3, 10);
  });
});

describe("drawdownStats", () => {
  it("empty equity → all zeros", () => {
    const dd = drawdownStats([]);
    expect(dd.maxDrawdown).toBe(0);
    expect(dd.maxDrawdownPercent).toBe(0);
    expect(dd.currentDrawdown).toBe(0);
  });

  it("single point → no drawdown", () => {
    const dd = drawdownStats([1000]);
    expect(dd.maxDrawdown).toBe(0);
    expect(dd.currentDrawdown).toBe(0);
  });

  it("monotonically increasing → no drawdown", () => {
    const dd = drawdownStats([1000, 1100, 1200, 1300]);
    expect(dd.maxDrawdown).toBe(0);
    expect(dd.currentDrawdown).toBe(0);
  });

  it("all losses → maxDrawdown = start - end", () => {
    const dd = drawdownStats([1000, 900, 700]);
    // peak=1000, trough=700, maxDD=300, maxDD%=300/1000=0.3
    expect(dd.maxDrawdown).toBe(300);
    expect(dd.maxDrawdownPercent).toBeCloseTo(0.3, 6);
    // current peak=1000, current=700, currentDD=300
    expect(dd.currentDrawdown).toBe(300);
    expect(dd.currentDrawdownPercent).toBeCloseTo(0.3, 6);
  });

  it("peak-then-trough-then-recovery → maxDD = peak-trough", () => {
    // 1000 → 1500 (peak) → 800 (trough) → 1200 (recovery)
    const dd = drawdownStats([1000, 1500, 800, 1200]);
    expect(dd.maxDrawdown).toBe(700);
    expect(dd.maxDrawdownPercent).toBeCloseTo(700 / 1500, 6);
    // current peak=1500, current=1200 → currentDD=300
    expect(dd.currentDrawdown).toBe(300);
    expect(dd.currentDrawdownPercent).toBeCloseTo(300 / 1500, 6);
  });

  it("new high after drawdown → currentDD=0", () => {
    // 1000 → 800 → 1500
    const dd = drawdownStats([1000, 800, 1500]);
    expect(dd.maxDrawdown).toBe(200); // peak=1000, trough=800
    expect(dd.currentDrawdown).toBe(0); // at new high
  });

  it("tracks maxDrawdownBottomIndex correctly", () => {
    // 1000 → 1500 → 800 (maxDD trough at idx 2) → 900 → 1200
    const dd = drawdownStats([1000, 1500, 800, 900, 1200]);
    expect(dd.maxDrawdownBottomIndex).toBe(2);
  });
});

describe("recoveryFactor", () => {
  it("no drawdown + positive net → Infinity", () => {
    expect(recoveryFactor(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
  it("no drawdown + zero net → 0", () => {
    expect(recoveryFactor(0, 0)).toBe(0);
  });
  it("no drawdown + negative net → 0", () => {
    expect(recoveryFactor(-100, 0)).toBe(0);
  });
  it("positive ratio when profit > drawdown", () => {
    expect(recoveryFactor(200, 100)).toBe(2);
  });
  it("fractional ratio when profit < drawdown", () => {
    expect(recoveryFactor(50, 100)).toBe(0.5);
  });
  it("negative ratio when losing", () => {
    expect(recoveryFactor(-200, 100)).toBe(-2);
  });
});

describe("computeStreaks", () => {
  it("zero trades → all zeros", () => {
    expect(computeStreaks(norm([]))).toEqual({
      longestWinStreak: 0,
      longestLossStreak: 0,
      currentStreak: 0,
    });
  });

  it("all wins → longestWinStreak=N, currentStreak=N", () => {
    const trades = norm([
      makeTrade({ result: "WIN" }),
      makeTrade({ result: "WIN" }),
      makeTrade({ result: "WIN" }),
    ]);
    const s = computeStreaks(trades);
    expect(s.longestWinStreak).toBe(3);
    expect(s.longestLossStreak).toBe(0);
    expect(s.currentStreak).toBe(3);
  });

  it("all losses → longestLossStreak=N, currentStreak=-N", () => {
    const trades = norm([makeTrade({ result: "LOSS" }), makeTrade({ result: "LOSS" })]);
    const s = computeStreaks(trades);
    expect(s.longestWinStreak).toBe(0);
    expect(s.longestLossStreak).toBe(2);
    expect(s.currentStreak).toBe(-2);
  });

  it("single trade → streak=1", () => {
    const trades = norm([makeTrade({ result: "WIN" })]);
    const s = computeStreaks(trades);
    expect(s.longestWinStreak).toBe(1);
    expect(s.currentStreak).toBe(1);
  });

  it("mixed → finds longest runs + current streak at end", () => {
    const trades = norm([
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-02T10:00:00Z") }),
      makeTrade({ result: "LOSS", openedAt: new Date("2026-01-03T10:00:00Z") }),
      makeTrade({ result: "LOSS", openedAt: new Date("2026-01-04T10:00:00Z") }),
      makeTrade({ result: "LOSS", openedAt: new Date("2026-01-05T10:00:00Z") }),
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-06T10:00:00Z") }),
    ]);
    const s = computeStreaks(trades);
    expect(s.longestWinStreak).toBe(2);
    expect(s.longestLossStreak).toBe(3);
    expect(s.currentStreak).toBe(1); // last trade is a WIN
  });

  it("tie at end → currentStreak=0", () => {
    const trades = norm([
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ result: "TIE", openedAt: new Date("2026-01-02T10:00:00Z") }),
    ]);
    const s = computeStreaks(trades);
    expect(s.longestWinStreak).toBe(1);
    expect(s.longestLossStreak).toBe(0);
    expect(s.currentStreak).toBe(0);
  });

  it("ties don't count toward win/loss streaks", () => {
    const trades = norm([
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ result: "TIE", openedAt: new Date("2026-01-02T10:00:00Z") }),
      makeTrade({ result: "WIN", openedAt: new Date("2026-01-03T10:00:00Z") }),
    ]);
    const s = computeStreaks(trades);
    // WIN, TIE (resets), WIN — longest win streak = 1
    expect(s.longestWinStreak).toBe(1);
  });
});

describe("computeEquityStats aggregator", () => {
  it("returns equity + drawdown + recovery + streaks in one pass", () => {
    const trades: TradeLike[] = [
      makeTrade({ result: "WIN", profitLoss: 100, openedAt: new Date("2026-01-01T10:00:00Z") }),
      makeTrade({ result: "LOSS", profitLoss: -50, openedAt: new Date("2026-01-02T10:00:00Z") }),
      makeTrade({ result: "WIN", profitLoss: 200, openedAt: new Date("2026-01-03T10:00:00Z") }),
    ];
    const stats = computeEquityStats(trades, 1000);
    // Equity: [1000, 1100, 1050, 1250]
    expect(stats.equity).toEqual([1000, 1100, 1050, 1250]);
    // Drawdown: peak=1100, trough=1050 → maxDD=50, maxDD%=50/1100≈0.0454
    expect(stats.drawdown.maxDrawdown).toBe(50);
    expect(stats.drawdown.maxDrawdownPercent).toBeCloseTo(50 / 1100, 6);
    // Recovery factor = netProfit / maxDD = 250 / 50 = 5
    expect(stats.recoveryFactor).toBe(5);
    // Streaks: WIN, LOSS, WIN — longest win streak = 1, longest loss streak = 1, current = +1 (WIN)
    expect(stats.streaks.longestWinStreak).toBe(1);
    expect(stats.streaks.longestLossStreak).toBe(1);
    expect(stats.streaks.currentStreak).toBe(1);
  });

  it("zero trades → equity=[start], drawdown=0, recovery=0, streaks=0", () => {
    const stats = computeEquityStats([], 1000);
    expect(stats.equity).toEqual([1000]);
    expect(stats.drawdown.maxDrawdown).toBe(0);
    expect(stats.recoveryFactor).toBe(0);
    expect(stats.streaks.longestWinStreak).toBe(0);
    expect(stats.streaks.currentStreak).toBe(0);
  });
});
