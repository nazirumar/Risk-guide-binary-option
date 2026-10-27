/**
 * Phase 8 — Monte Carlo simulator tests.
 *
 * Uses a seeded RNG so outputs are deterministic. Tests cover:
 *   - Determinism (same seed → same result)
 *   - Ruin detection (high risk per trade → high chance of ruin)
 *   - Aggregation (median, mean, percentiles, histogram)
 *   - Edge cases (zero trades, all-win, all-loss, zero ruin threshold)
 */
import { describe, it, expect } from "vitest";
import { simulateOnce, runMonteCarlo } from "@/lib/staking";
import type { PlanConfig } from "@/lib/staking";

describe("simulateOnce — single simulation", () => {
  const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 10 };
  // Simple seeded RNG that always returns 0.5 → ties (between winRate and winRate+0.02)
  // Actually 0.5 > winRate (0.55) → LOSS. So all losses.
  // Let me use a fixed-LOSS RNG: rng() returns 1.0 → always LOSS.

  it("all-LOSS RNG → balance decreases by stake each trade", () => {
    const alwaysLoss = () => 1.0; // > winRate → LOSS
    const result = simulateOnce(1000, 10, 0.55, 0.85, config, alwaysLoss, 0);
    // 10 losses × $10 stake = $100 loss → balance = $900.
    expect(result.endingBalance).toBe(900);
    expect(result.ruined).toBe(false);
    // Max drawdown = 10 × 10 = 100.
    expect(result.maxDrawdown).toBe(100);
  });

  it("all-WIN RNG → balance grows by stake×payout each trade", () => {
    const alwaysWin = () => 0.0; // < winRate → WIN
    const result = simulateOnce(1000, 10, 0.55, 0.85, config, alwaysWin, 0);
    // 10 wins × $10 × 0.85 = $85 profit → balance = $1085.
    expect(result.endingBalance).toBe(1085);
    expect(result.ruined).toBe(false);
    expect(result.maxDrawdown).toBe(0); // never went below start
  });

  it("detects ruin when balance falls below ruinThreshold", () => {
    // Start $100, stake $20, ruin threshold 50% ($50). 3 losses → balance = $40 < $50 → ruined.
    const alwaysLoss = () => 1.0;
    const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 20 };
    const result = simulateOnce(100, 10, 0.55, 0.85, config, alwaysLoss, 0.5);
    // After 3 losses: $100 - $60 = $40 < $50 (ruin threshold).
    // Actually let me trace: trade1 stake=$20 bal=$80; trade2 stake=$20 bal=$60;
    // trade3 stake=$20 bal=$40 → $40 < $50 → ruined. Stops after 3 trades.
    expect(result.ruined).toBe(true);
    expect(result.endingBalance).toBe(40);
  });

  it("zero trades → returns starting balance, no ruin, no drawdown", () => {
    const result = simulateOnce(1000, 0, 0.55, 0.85, config, () => 0.5, 0);
    expect(result.endingBalance).toBe(1000);
    expect(result.ruined).toBe(false);
    expect(result.maxDrawdown).toBe(0);
  });

  it("FIXED_PERCENT plan scales stake with balance", () => {
    // 2% of $1000 = $20 stake. All wins: $20 × 0.85 = $17 per trade.
    // After 10 wins: $1000 + $170 = $1170.
    const config: PlanConfig = { method: "FIXED_PERCENT", percent: 0.02 };
    const alwaysWin = () => 0.0;
    const result = simulateOnce(1000, 10, 0.55, 0.85, config, alwaysWin, 0);
    // Actually FIXED_PERCENT uses the CURRENT balance each trade (balance changes).
    // Trade 1: stake = 0.02 × 1000 = 20. WIN → +20×0.85=17 → bal=1017.
    // Trade 2: stake = 0.02 × 1017 = 20.34. WIN → +17.289 → bal=1034.289.
    // ... — compounding. Let me just check it's > 1000 + 10×17 = 1170.
    expect(result.endingBalance).toBeGreaterThan(1170);
  });
});

describe("runMonteCarlo — aggregation", () => {
  it("determinism — same seed → same result", () => {
    const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 10 };
    const opts = {
      startingBalance: 1000,
      numSimulations: 100,
      numTradesPerSim: 50,
      winRate: 0.55,
      payoutPercent: 0.85,
      config,
      seed: 12345,
    };
    const r1 = runMonteCarlo(opts);
    const r2 = runMonteCarlo(opts);
    expect(r1.medianEndingBalance).toBe(r2.medianEndingBalance);
    expect(r1.chanceOfRuin).toBe(r2.chanceOfRuin);
    expect(r1.histogram).toEqual(r2.histogram);
  });

  it("returns the right counts + percentiles", () => {
    const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 10 };
    const r = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 100,
      numTradesPerSim: 50,
      winRate: 0.55,
      payoutPercent: 0.85,
      config,
      seed: 42,
    });
    expect(r.numSimulations).toBe(100);
    expect(r.numTradesPerSim).toBe(50);
    expect(r.startingBalance).toBe(1000);
    expect(r.endingBalances.length).toBe(100);
    expect(r.ruinedCount).toBeGreaterThanOrEqual(0);
    expect(r.ruinedCount).toBeLessThanOrEqual(100);
    expect(r.chanceOfRuin).toBeGreaterThanOrEqual(0);
    expect(r.chanceOfRuin).toBeLessThanOrEqual(1);
    expect(r.medianEndingBalance).toBeGreaterThan(0);
    expect(r.meanEndingBalance).toBeGreaterThan(0);
    expect(r.p10EndingBalance).toBeLessThanOrEqual(r.medianEndingBalance);
    expect(r.p90EndingBalance).toBeGreaterThanOrEqual(r.medianEndingBalance);
  });

  it("histogram has 10 bins", () => {
    const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 10 };
    const r = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 50,
      numTradesPerSim: 30,
      winRate: 0.55,
      payoutPercent: 0.85,
      config,
      seed: 1,
    });
    expect(r.histogram.length).toBe(10);
    const total = r.histogram.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(50); // all ending balances binned
  });

  it("high-risk plan → higher chance of ruin than low-risk", () => {
    // Compare FIXED_AMOUNT $10 stake vs $100 stake on $1000 balance.
    const lowRisk: PlanConfig = { method: "FIXED_AMOUNT", amount: 10 };
    const highRisk: PlanConfig = { method: "FIXED_AMOUNT", amount: 100 };
    const low = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 200,
      numTradesPerSim: 50,
      winRate: 0.55,
      payoutPercent: 0.85,
      config: lowRisk,
      seed: 7,
      ruinThreshold: 0.5,
    });
    const high = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 200,
      numTradesPerSim: 50,
      winRate: 0.55,
      payoutPercent: 0.85,
      config: highRisk,
      seed: 7,
      ruinThreshold: 0.5,
    });
    expect(high.chanceOfRuin).toBeGreaterThan(low.chanceOfRuin);
  });

  it("winning plan (high win-rate + high payout) → positive median ending balance", () => {
    const config: PlanConfig = { method: "FIXED_PERCENT", percent: 0.02 };
    const r = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 100,
      numTradesPerSim: 100,
      winRate: 0.65, // high win-rate
      payoutPercent: 0.9, // high payout
      config,
      seed: 99,
    });
    expect(r.medianEndingBalance).toBeGreaterThan(1000);
  });

  it("losing plan (low win-rate) → negative median ending balance", () => {
    const config: PlanConfig = { method: "FIXED_PERCENT", percent: 0.02 };
    const r = runMonteCarlo({
      startingBalance: 1000,
      numSimulations: 100,
      numTradesPerSim: 100,
      winRate: 0.4, // low win-rate (negative edge)
      payoutPercent: 0.85,
      config,
      seed: 99,
    });
    expect(r.medianEndingBalance).toBeLessThan(1000);
  });
});
