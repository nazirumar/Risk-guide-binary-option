/**
 * Phase 8 — unit tests for each staking plan's sequence logic.
 *
 * Each test verifies that computeNextStake() returns the correct value for
 * a given context + config. Edge cases: zero balance, capped steps,
 * reset-on-win, reset-on-loss, empty ladder.
 */
import { describe, it, expect } from "vitest";
import {
  computeNextStake,
  martingaleWorstCaseExposure,
  martingaleCapHitProbability,
  kellyFullFraction,
  isMartingale,
} from "@/lib/staking";
import type { StakingContext, PlanConfig } from "@/lib/staking";

function ctx(overrides: Partial<StakingContext> = {}): StakingContext {
  return {
    balance: 1000,
    recentResults: [],
    consecutiveLosses: 0,
    consecutiveWins: 0,
    tradeNumber: 1,
    payoutPercent: 0.85,
    winRate: 0.55,
    ...overrides,
  };
}

describe("FIXED_AMOUNT", () => {
  const config: PlanConfig = { method: "FIXED_AMOUNT", amount: 25 };
  it("returns the flat amount regardless of context", () => {
    expect(computeNextStake(ctx(), config)).toBe(25);
    expect(computeNextStake(ctx({ balance: 5000, consecutiveLosses: 5 }), config)).toBe(25);
  });
  it("returns 0 for negative amount", () => {
    const neg: PlanConfig = { method: "FIXED_AMOUNT", amount: -10 };
    expect(computeNextStake(ctx(), neg)).toBe(0);
  });
});

describe("FIXED_PERCENT", () => {
  const config: PlanConfig = { method: "FIXED_PERCENT", percent: 0.02 };
  it("returns 2% of current balance", () => {
    expect(computeNextStake(ctx({ balance: 1000 }), config)).toBe(20);
  });
  it("scales with balance", () => {
    expect(computeNextStake(ctx({ balance: 5000 }), config)).toBe(100);
  });
  it("returns 0 for zero balance", () => {
    expect(computeNextStake(ctx({ balance: 0 }), config)).toBe(0);
  });
});

describe("COMPOUNDING", () => {
  const config: PlanConfig = { method: "COMPOUNDING", percent: 0.02 };
  it("returns 2% of current balance (same as FIXED_PERCENT at one trade)", () => {
    expect(computeNextStake(ctx({ balance: 1000 }), config)).toBe(20);
  });
  // The difference from FIXED_PERCENT shows up across multiple trades
  // (COMPOUNDING reinvests; FIXED_PERCENT uses the STARTING balance).
  // Monte Carlo tests cover that behavior.
});

describe("ANTI_MARTINGALE (increase after wins, capped)", () => {
  const config: PlanConfig = {
    method: "ANTI_MARTINGALE",
    basePercent: 0.02,
    increaseFactor: 1.5,
    capPercent: 0.06,
  };
  it("starts at base percent after a loss (reset)", () => {
    expect(computeNextStake(ctx({ consecutiveWins: 0, consecutiveLosses: 1 }), config)).toBe(20);
  });
  it("increases by factor after 1 win", () => {
    // 0.02 × 1.5 = 0.03 → 3% of $1000 = $30
    expect(computeNextStake(ctx({ consecutiveWins: 1 }), config)).toBe(30);
  });
  it("increases by factor² after 2 wins", () => {
    // 0.02 × 1.5² = 0.045 → 4.5% of $1000 = $45
    expect(computeNextStake(ctx({ consecutiveWins: 2 }), config)).toBe(45);
  });
  it("caps at capPercent after many wins", () => {
    // 0.02 × 1.5³ = 0.0675 → would be 6.75% but cap is 6% → $60
    expect(computeNextStake(ctx({ consecutiveWins: 3 }), config)).toBe(60);
    expect(computeNextStake(ctx({ consecutiveWins: 10 }), config)).toBe(60);
  });
  it("resets to base after a loss (consecutiveWins=0)", () => {
    expect(computeNextStake(ctx({ consecutiveWins: 0, consecutiveLosses: 1 }), config)).toBe(20);
  });
});

describe("FIBONACCI", () => {
  const config: PlanConfig = { method: "FIBONACCI", baseUnit: 1, maxSteps: 8 };
  it("starts at 1 × baseUnit (Fib[0] = 1)", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 0 }), config)).toBe(1);
  });
  it("1 loss → Fib[1] = 1 × baseUnit", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 1 }), config)).toBe(1);
  });
  it("2 losses → Fib[2] = 2 × baseUnit", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 2 }), config)).toBe(2);
  });
  it("3 losses → Fib[3] = 3 × baseUnit", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 3 }), config)).toBe(3);
  });
  it("4 losses → Fib[4] = 5 × baseUnit", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 4 }), config)).toBe(5);
  });
  it("5 losses → Fib[5] = 8 × baseUnit", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 5 }), config)).toBe(8);
  });
  it("caps at maxSteps", () => {
    // maxSteps=8 → Fib[8] = 34 × baseUnit. Beyond that, stays at 34.
    expect(computeNextStake(ctx({ consecutiveLosses: 8 }), config)).toBe(34);
    expect(computeNextStake(ctx({ consecutiveLosses: 15 }), config)).toBe(34);
  });
  it("scales with baseUnit", () => {
    const c: PlanConfig = { method: "FIBONACCI", baseUnit: 10, maxSteps: 8 };
    expect(computeNextStake(ctx({ consecutiveLosses: 4 }), c)).toBe(50);
  });
});

describe("MARTINGALE (OFF by default, red warning, hard cap)", () => {
  const config: PlanConfig = { method: "MARTINGALE", baseUnit: 1, maxSteps: 5 };

  it("starts at baseUnit (2^0)", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 0 }), config)).toBe(1);
  });
  it("1 loss → 2 × baseUnit (2^1)", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 1 }), config)).toBe(2);
  });
  it("2 losses → 4 × baseUnit (2^2)", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 2 }), config)).toBe(4);
  });
  it("3 losses → 8 × baseUnit (2^3)", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 3 }), config)).toBe(8);
  });
  it("5 losses → 32 × baseUnit (2^5) — the cap", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 5 }), config)).toBe(32);
  });
  it("caps at maxSteps — 10 losses still = 32", () => {
    expect(computeNextStake(ctx({ consecutiveLosses: 10 }), config)).toBe(32);
  });

  it("worst-case exposure = baseUnit × (2^(maxSteps+1) − 1)", () => {
    // maxSteps=5 → 2^6 − 1 = 63. So $1 × 63 = $63.
    expect(martingaleWorstCaseExposure(1, 5)).toBe(63);
    expect(martingaleWorstCaseExposure(10, 5)).toBe(630);
  });

  it("cap-hit probability = (1 − winRate)^(maxSteps + 1)", () => {
    // winRate=0.55, maxSteps=5 → 0.45^6 ≈ 0.0083
    expect(martingaleCapHitProbability(0.55, 5)).toBeCloseTo(Math.pow(0.45, 6), 6);
  });

  it("isMartingale() returns true for MARTINGALE config", () => {
    expect(isMartingale(config)).toBe(true);
    expect(isMartingale({ method: "FIXED_AMOUNT", amount: 10 })).toBe(false);
  });
});

describe("KELLY_FRACTION", () => {
  it("full Kelly for winRate=0.55, payout=0.85", () => {
    // edge = 0.55 × 1.85 − 1 = 0.0175
    // f = 0.0175 / 0.85 = 0.020588
    // Full Kelly stake = 1000 × 0.020588 = $20.59
    const config: PlanConfig = { method: "KELLY_FRACTION", fraction: 1 };
    const stake = computeNextStake(
      ctx({ winRate: 0.55, payoutPercent: 0.85, balance: 1000 }),
      config,
    );
    expect(stake).toBeCloseTo(20.59, 1);
  });

  it("half Kelly = half the full Kelly stake", () => {
    const config: PlanConfig = { method: "KELLY_FRACTION", fraction: 0.5 };
    const stake = computeNextStake(
      ctx({ winRate: 0.55, payoutPercent: 0.85, balance: 1000 }),
      config,
    );
    expect(stake).toBeCloseTo(10.29, 1);
  });

  it("quarter Kelly = quarter the full Kelly stake", () => {
    const config: PlanConfig = { method: "KELLY_FRACTION", fraction: 0.25 };
    const stake = computeNextStake(
      ctx({ winRate: 0.55, payoutPercent: 0.85, balance: 1000 }),
      config,
    );
    expect(stake).toBeCloseTo(5.15, 1);
  });

  it("returns 0 for negative edge (no edge)", () => {
    // winRate=0.40, payout=0.85 → edge = 0.40 × 1.85 − 1 = −0.26
    const config: PlanConfig = { method: "KELLY_FRACTION", fraction: 1 };
    const stake = computeNextStake(
      ctx({ winRate: 0.4, payoutPercent: 0.85, balance: 1000 }),
      config,
    );
    expect(stake).toBe(0);
  });

  it("returns 0 for break-even edge", () => {
    // winRate × (1 + payout) = 1 → winRate = 1/1.85 ≈ 0.5405
    const config: PlanConfig = { method: "KELLY_FRACTION", fraction: 1 };
    const stake = computeNextStake(
      ctx({ winRate: 1 / 1.85, payoutPercent: 0.85, balance: 1000 }),
      config,
    );
    expect(stake).toBe(0);
  });

  it("kellyFullFraction helper returns the right value", () => {
    expect(kellyFullFraction(0.55, 0.85)).toBeCloseTo(0.020588, 6);
    expect(kellyFullFraction(0.4, 0.85)).toBe(0);
  });
});

describe("CUSTOM ladder", () => {
  const config: PlanConfig = { method: "CUSTOM", ladder: [10, 20, 30, 40] };

  it("trade 1 → first ladder value", () => {
    expect(computeNextStake(ctx({ tradeNumber: 1 }), config)).toBe(10);
  });
  it("trade 2 → second ladder value", () => {
    expect(computeNextStake(ctx({ tradeNumber: 2 }), config)).toBe(20);
  });
  it("trade 4 → last ladder value", () => {
    expect(computeNextStake(ctx({ tradeNumber: 4 }), config)).toBe(40);
  });
  it("trade 5+ → repeats the last ladder value", () => {
    expect(computeNextStake(ctx({ tradeNumber: 5 }), config)).toBe(40);
    expect(computeNextStake(ctx({ tradeNumber: 100 }), config)).toBe(40);
  });
  it("empty ladder → 0", () => {
    const c: PlanConfig = { method: "CUSTOM", ladder: [] };
    expect(computeNextStake(ctx(), c)).toBe(0);
  });
});

describe("computeNextStake dispatcher", () => {
  it("returns 0 for unknown method", () => {
    // @ts-expect-error — testing unknown method
    expect(computeNextStake(ctx(), { method: "UNKNOWN" })).toBe(0);
  });
});
