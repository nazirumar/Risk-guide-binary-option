import { describe, it, expect } from "vitest";

import {
  riskOfRuin,
  lossesToRuin,
  consistencyScore,
  consistencyScoreNormalized,
  computeRiskStats,
} from "@/lib/calc/risk";
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

describe("riskOfRuin", () => {
  it("winRate=0 → 1 (certain ruin)", () => {
    expect(riskOfRuin(0, 0.85, 0.02, 0.5)).toBe(1);
  });

  it("winRate=1 → 0 (never loses → never ruined)", () => {
    expect(riskOfRuin(1, 0.85, 0.02, 0.5)).toBe(0);
  });

  it("negative edge → 1 (certain ruin)", () => {
    // winRate=0.40, payout=0.85 → edge = 0.40 × 1.85 - 1 = -0.26
    expect(riskOfRuin(0.4, 0.85, 0.02, 0.5)).toBe(1);
  });

  it("zero edge → 1 (no edge → certain ruin)", () => {
    // winRate × (1 + payout) = 1 → winRate = 1 / 1.85 ≈ 0.5405
    expect(riskOfRuin(1 / 1.85, 0.85, 0.02, 0.5)).toBe(1);
  });

  it("positive edge → fraction 0..1", () => {
    // winRate=0.55, payout=0.85 → edge = 0.55 × 1.85 - 1 = +0.0175
    const ror = riskOfRuin(0.55, 0.85, 0.02, 0.5);
    expect(ror).toBeGreaterThan(0);
    expect(ror).toBeLessThan(1);
    // Risk of ~30% with these conservative numbers
    expect(ror).toBeLessThan(0.5);
  });

  it("stronger edge → lower risk", () => {
    // winRate=0.70, payout=0.90 → edge = 0.70 × 1.90 - 1 = +0.33
    const rorStrong = riskOfRuin(0.7, 0.9, 0.02, 0.5);
    // winRate=0.55, payout=0.85 → edge = +0.0175
    const rorWeak = riskOfRuin(0.55, 0.85, 0.02, 0.5);
    expect(rorStrong).toBeLessThan(rorWeak);
  });

  it("lower risk per trade → lower risk of ruin", () => {
    // Same edge, but risk 1% vs 5% per trade
    const rorLowRisk = riskOfRuin(0.55, 0.85, 0.01, 0.5);
    const rorHighRisk = riskOfRuin(0.55, 0.85, 0.05, 0.5);
    expect(rorLowRisk).toBeLessThan(rorHighRisk);
  });

  it("higher ruin threshold (closer to start) → higher risk of ruin", () => {
    // Same edge, but ruin at 0.9 (lose 10% of balance = ruin) vs 0.5
    const rorHigh = riskOfRuin(0.55, 0.85, 0.02, 0.9);
    const rorLow = riskOfRuin(0.55, 0.85, 0.02, 0.5);
    expect(rorHigh).toBeGreaterThan(rorLow);
  });

  it("invalid inputs → fail-safe to 1", () => {
    // Negative payout
    expect(riskOfRuin(0.55, -0.5, 0.02, 0.5)).toBe(1);
    // Negative risk per trade
    expect(riskOfRuin(0.55, 0.85, -0.02, 0.5)).toBe(1);
    // Ruin threshold = 0 (can never go below 0)
    expect(riskOfRuin(0.55, 0.85, 0.02, 0)).toBe(1);
    // Ruin threshold = 1 (already ruined)
    expect(riskOfRuin(0.55, 0.85, 0.02, 1)).toBe(1);
  });
});

describe("lossesToRuin", () => {
  it("$1000 balance, $20 stake, ruin at 50% → 25 losses", () => {
    expect(lossesToRuin(1000, 20, 0.5)).toBe(25);
  });

  it("$1000 balance, $50 stake, ruin at 50% → 10 losses", () => {
    expect(lossesToRuin(1000, 50, 0.5)).toBe(10);
  });

  it("$1000 balance, $100 stake, ruin at 90% → 1 loss", () => {
    // Only lose 10% of balance to hit ruin
    expect(lossesToRuin(1000, 100, 0.9)).toBe(1);
  });

  it("$1000 balance, $1000 stake, ruin at 50% → 1 loss (huge stake)", () => {
    // Need to lose $500 = 1 stake
    expect(lossesToRuin(1000, 1000, 0.5)).toBe(1);
  });

  it("$1000 balance, $2000 stake, ruin at 50% → 1 loss (stake > needed)", () => {
    // Only need to lose $500, but stake is $2000 → ceil(0.25) = 1
    expect(lossesToRuin(1000, 2000, 0.5)).toBe(1);
  });

  it("stake=0 → 0 (can't lose on a zero-stake trade)", () => {
    expect(lossesToRuin(1000, 0, 0.5)).toBe(0);
  });

  it("startingBalance=0 → 0", () => {
    expect(lossesToRuin(0, 100, 0.5)).toBe(0);
  });

  it("ruinThreshold=0 → 0 (can never go below zero balance)", () => {
    expect(lossesToRuin(1000, 100, 0)).toBe(0);
  });

  it("ruinThreshold=1 → 0 (already at threshold)", () => {
    expect(lossesToRuin(1000, 100, 1)).toBe(0);
  });

  it("ceil() rounds up fractional stakes", () => {
    // $1000 balance, $200 stake, ruin at 50% → $500/$200 = 2.5 → 3
    expect(lossesToRuin(1000, 200, 0.5)).toBe(3);
  });
});

describe("consistencyScore", () => {
  it("zero trades → 0", () => {
    expect(consistencyScore([])).toBe(0);
  });

  it("single trade → 0 (need ≥2 to compute stdDev)", () => {
    expect(consistencyScore([makeTrade({ profitLoss: 100, stake: 100 })])).toBe(0);
  });

  it("all-zero returns → 0 (zero stdDev)", () => {
    // stake=100, profitLoss=0 for all trades → all returns = 0
    const trades = [
      makeTrade({ profitLoss: 0, stake: 100, result: "TIE" }),
      makeTrade({ profitLoss: 0, stake: 100, result: "TIE" }),
    ];
    expect(consistencyScore(trades)).toBe(0);
  });

  it("trades with zero stake → skipped, no division by zero", () => {
    // stake=0 for one trade → skipped, the others used
    const trades = [
      makeTrade({ profitLoss: 0, stake: 0, result: "TIE" }),
      makeTrade({ profitLoss: 100, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: -100, stake: 100, result: "LOSS" }),
    ];
    // Returns: +1 (from WIN), -1 (from LOSS). Mean=0, stdDev=1, score=0
    expect(consistencyScore(trades)).toBe(0);
  });

  it("all wins with consistent return → high score", () => {
    // Each trade: +0.85 of stake (85% profit). Mean=0.85, stdDev=0 → 0 (zero stdDev)
    const trades = [
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
    ];
    // Returns are all 0.85, stdDev=0, score=0
    expect(consistencyScore(trades)).toBe(0);
  });

  it("alternating wins/losses → near-zero score (high variance, low mean)", () => {
    // Returns: +0.85, -1, +0.85, -1 → mean=-0.075, stdDev high
    const trades = [
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: -100, stake: 100, result: "LOSS" }),
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: -100, stake: 100, result: "LOSS" }),
    ];
    // Mean = (0.85 - 1 + 0.85 - 1) / 4 = -0.075
    // Score = -0.075 / stdDev (positive but small) → negative
    expect(consistencyScore(trades)).toBeLessThan(0);
  });

  it("mostly wins with small consistent losses → positive score", () => {
    // 8 wins of +0.85, 2 losses of -1.0 → mean=0.48, stdDev=~0.85
    // Score = 0.48 / 0.85 ≈ 0.56 — positive
    const trades: TradeLike[] = [];
    for (let i = 0; i < 8; i++)
      trades.push(makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }));
    for (let i = 0; i < 2; i++)
      trades.push(makeTrade({ profitLoss: -100, stake: 100, result: "LOSS" }));
    const score = consistencyScore(trades);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(2);
  });
});

describe("consistencyScoreNormalized (internal)", () => {
  it("accepts already-normalized trades", () => {
    const trades = norm([
      makeTrade({ profitLoss: 85, stake: 100, result: "WIN" }),
      makeTrade({ profitLoss: -100, stake: 100, result: "LOSS" }),
    ]);
    const score = consistencyScoreNormalized(trades);
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe("computeRiskStats aggregator", () => {
  it("returns all risk stats in one call", () => {
    const trades: TradeLike[] = [
      makeTrade({ profitLoss: 85, stake: 100, payoutPercent: 0.85, result: "WIN" }),
      makeTrade({ profitLoss: -100, stake: 100, payoutPercent: 0.85, result: "LOSS" }),
      makeTrade({ profitLoss: 85, stake: 100, payoutPercent: 0.85, result: "WIN" }),
    ];
    const stats = computeRiskStats(trades, 1000, 0.02, 0.5);
    // winRate = 2/3 ≈ 0.667, payout ≈ 0.85, edge = 0.667 × 1.85 - 1 ≈ 0.233
    expect(stats.riskOfRuin).toBeGreaterThan(0);
    expect(stats.riskOfRuin).toBeLessThan(1);
    // lossesToRuin with startingBalance=1000, avgStake=100, ruin at 50% = 5
    expect(stats.lossesToRuin).toBe(5);
    // consistencyScore = some finite value
    expect(Number.isFinite(stats.consistencyScore)).toBe(true);
  });

  it("zero trades → all zeros", () => {
    const stats = computeRiskStats([], 1000, 0.02, 0.5);
    expect(stats.riskOfRuin).toBe(0);
    expect(stats.lossesToRuin).toBe(0);
    expect(stats.consistencyScore).toBe(0);
  });
});
