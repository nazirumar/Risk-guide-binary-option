/**
 * Phase 17 — buildConfirmationSummary unit tests.
 *
 * The confirmation modal must show correct live numbers. These tests pin
 * every derived value: potential profit/loss, stake % of balance, daily loss
 * used %, trades remaining today, and the plan-match deviation — including
 * edge cases (no limits set, profitable day, zero balance, no plan).
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import { buildConfirmationSummary } from "@/lib/calc/confirmation";

function baseInput(overrides: Partial<Parameters<typeof buildConfirmationSummary>[0]> = {}) {
  return {
    stake: "10",
    payoutPercent: "0.85",
    asset: "EUR/USD",
    direction: "CALL" as const,
    expiryMinutes: 5,
    balance: "1000",
    currency: "USD",
    dailyPL: "0",
    maxDailyLossPercent: "6",
    maxDailyLossAmount: null,
    maxTradesPerDay: 10,
    tradesToday: 0,
    currentLossStreak: 0,
    tiltLevel: "CALM" as const,
    tiltScore: 0,
    planSuggestedStake: null,
    planName: null,
    ...overrides,
  };
}

describe("buildConfirmationSummary — core numbers", () => {
  it("computes potential profit and loss for a standard trade", () => {
    const s = buildConfirmationSummary(baseInput());
    // stake 10, payout 85% → profit +8.50, loss -10.00
    expect(s.potentialProfit).toBe("8.50");
    expect(s.potentialLoss).toBe("-10.00");
    expect(s.stake).toBe("10.00");
  });

  it("computes stake as % of balance (fraction)", () => {
    const s = buildConfirmationSummary(baseInput({ stake: "25", balance: "1000" }));
    // 25 / 1000 = 0.025 = 2.5%
    expect(new Decimal(s.stakePercentOfBalance).toNumber()).toBeCloseTo(0.025, 6);
  });

  it("computes break-even win rate from payout", () => {
    const s = buildConfirmationSummary(baseInput({ payoutPercent: "0.85" }));
    // 1 / 1.85 ≈ 0.540541
    expect(new Decimal(s.breakEvenWinRate).toNumber()).toBeCloseTo(0.540541, 5);
  });

  it("passes through asset, direction, expiry, currency and tilt", () => {
    const s = buildConfirmationSummary(
      baseInput({
        asset: "BTC/USD",
        direction: "PUT",
        expiryMinutes: 15,
        tiltLevel: "CAUTION",
        tiltScore: 45,
      }),
    );
    expect(s.asset).toBe("BTC/USD");
    expect(s.direction).toBe("PUT");
    expect(s.expiryMinutes).toBe(15);
    expect(s.tiltLevel).toBe("CAUTION");
    expect(s.tiltScore).toBe(45);
  });
});

describe("buildConfirmationSummary — daily loss used %", () => {
  it("is 0 when today's P/L is zero or positive", () => {
    expect(buildConfirmationSummary(baseInput({ dailyPL: "0" })).dailyLossUsedPercent).toBe("0");
    expect(buildConfirmationSummary(baseInput({ dailyPL: "50" })).dailyLossUsedPercent).toBe("0");
  });

  it("computes loss used against the percent-of-balance limit", () => {
    // Lost 30 today; limit 6% of 1000 = 60 → 30/60 = 0.5 (50%)
    const s = buildConfirmationSummary(baseInput({ dailyPL: "-30", maxDailyLossPercent: "6" }));
    expect(new Decimal(s.dailyLossUsedPercent!).toNumber()).toBeCloseTo(0.5, 6);
  });

  it("uses the flat amount limit when it is the smaller cap", () => {
    // Balance 1000, 6% = 60; flat cap 40 → effective limit 40.
    // Lost 30 → 30/40 = 0.75
    const s = buildConfirmationSummary(
      baseInput({ dailyPL: "-30", maxDailyLossPercent: "6", maxDailyLossAmount: "40" }),
    );
    expect(new Decimal(s.dailyLossUsedPercent!).toNumber()).toBeCloseTo(0.75, 6);
  });

  it("uses the percent limit when it is the smaller cap", () => {
    // Balance 500, 6% = 30; flat cap 100 → effective limit 30.
    // Lost 12 → 12/30 = 0.4
    const s = buildConfirmationSummary(
      baseInput({
        balance: "500",
        dailyPL: "-12",
        maxDailyLossPercent: "6",
        maxDailyLossAmount: "100",
      }),
    );
    expect(new Decimal(s.dailyLossUsedPercent!).toNumber()).toBeCloseTo(0.4, 6);
  });

  it("returns null when no daily loss limit is configured", () => {
    const s = buildConfirmationSummary(
      baseInput({ dailyPL: "-30", maxDailyLossPercent: null, maxDailyLossAmount: null }),
    );
    expect(s.dailyLossUsedPercent).toBeNull();
    // Raw daily P/L is still surfaced for display.
    expect(s.dailyPL).toBe("-30.00");
  });

  it("can exceed 100% (limit overshot but trade not yet blocked)", () => {
    // Lost 90 against a 60 cap → 1.5
    const s = buildConfirmationSummary(baseInput({ dailyPL: "-90", maxDailyLossPercent: "6" }));
    expect(new Decimal(s.dailyLossUsedPercent!).toNumber()).toBeCloseTo(1.5, 6);
  });
});

describe("buildConfirmationSummary — trades remaining today", () => {
  it("subtracts trades used from the daily cap", () => {
    const s = buildConfirmationSummary(baseInput({ maxTradesPerDay: 10, tradesToday: 4 }));
    expect(s.tradesRemainingToday).toBe(6);
    expect(s.tradesToday).toBe(4);
  });

  it("floors at 0 when the cap is already reached", () => {
    const s = buildConfirmationSummary(baseInput({ maxTradesPerDay: 5, tradesToday: 7 }));
    expect(s.tradesRemainingToday).toBe(0);
  });
});

describe("buildConfirmationSummary — staking plan match", () => {
  it("reports matches=true when stake equals the suggestion (2dp)", () => {
    const s = buildConfirmationSummary(
      baseInput({ stake: "10", planSuggestedStake: "10.00", planName: "Fixed $10" }),
    );
    expect(s.plan.hasPlan).toBe(true);
    expect(s.plan.matches).toBe(true);
    expect(s.plan.suggestedStake).toBe("10.00");
    expect(s.plan.deviation).toBe("0.00");
    expect(new Decimal(s.plan.deviationPercent!).toNumber()).toBe(0);
  });

  it("computes positive deviation when staking above the plan", () => {
    const s = buildConfirmationSummary(
      baseInput({ stake: "15", planSuggestedStake: "10.00", planName: "Fixed $10" }),
    );
    expect(s.plan.matches).toBe(false);
    expect(s.plan.deviation).toBe("5.00");
    expect(new Decimal(s.plan.deviationPercent!).toNumber()).toBeCloseTo(0.5, 6);
  });

  it("computes negative deviation when staking below the plan", () => {
    const s = buildConfirmationSummary(
      baseInput({ stake: "8", planSuggestedStake: "10.00", planName: "Fixed $10" }),
    );
    expect(s.plan.matches).toBe(false);
    expect(s.plan.deviation).toBe("-2.00");
    expect(new Decimal(s.plan.deviationPercent!).toNumber()).toBeCloseTo(-0.2, 6);
  });

  it("reports hasPlan=false when no staking plan exists", () => {
    const s = buildConfirmationSummary(baseInput({ planSuggestedStake: null, planName: null }));
    expect(s.plan.hasPlan).toBe(false);
    expect(s.plan.matches).toBe(false);
    expect(s.plan.suggestedStake).toBeNull();
    expect(s.plan.deviation).toBeNull();
  });

  it("treats a sub-cent difference as a match (2dp comparison)", () => {
    const s = buildConfirmationSummary(
      baseInput({ stake: "10.001", planSuggestedStake: "10.00", planName: "P" }),
    );
    expect(s.plan.matches).toBe(true);
  });
});

describe("buildConfirmationSummary — edge cases", () => {
  it("handles a zero balance without crashing (stake % falls back to 0)", () => {
    const s = buildConfirmationSummary(baseInput({ balance: "0", stake: "10" }));
    expect(s.stakePercentOfBalance).toBe("0");
  });

  it("rounds stake, profit and loss to 2dp", () => {
    const s = buildConfirmationSummary(baseInput({ stake: "10.555", payoutPercent: "0.856" }));
    expect(s.stake).toBe("10.56"); // Decimal 10.555 → 10.56 (half-up)
    expect(s.potentialProfit).toBe("9.04"); // 10.56 × 0.856 = 9.03936 → 9.04
    expect(s.potentialLoss).toBe("-10.56");
  });

  it("handles Decimal inputs (not just strings)", () => {
    const s = buildConfirmationSummary(
      baseInput({
        stake: new Decimal(20),
        balance: new Decimal("800"),
        dailyPL: new Decimal("-16"),
      }),
    );
    expect(s.stake).toBe("20.00");
    expect(new Decimal(s.stakePercentOfBalance).toNumber()).toBeCloseTo(0.025, 6);
    expect(new Decimal(s.dailyLossUsedPercent!).toNumber()).toBeCloseTo(1 / 3, 5);
  });
});
