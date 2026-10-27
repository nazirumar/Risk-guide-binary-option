import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

/**
 * Sanity test — verifies the Vitest runner + decimal.js (which the rest of
 * the app relies on for all money math per PROJECT_RULES.md rule #1) is wired
 * up correctly. The real calculation engine arrives in Phase 6.
 */
describe("vitest sanity", () => {
  it("runs basic assertions", () => {
    expect(1 + 1).toBe(2);
  });

  it("decimal.js performs precise money math (no float drift)", () => {
    const stake = new Decimal("0.10");
    const payout = new Decimal("0.85");
    // 100 trades at 0.10 stake with 85% payout on a win
    const winProfit = stake.mul(payout); // 0.085
    const lossCost = stake; // 0.10 — decimal.js strips trailing zero, value is 0.1
    expect(winProfit.toString()).toBe("0.085");
    expect(lossCost.toFixed(2)).toBe("0.10");

    // Floating-point comparison sanity: 0.1 + 0.2 in IEEE 754 ≠ 0.3, but Decimal gets it right.
    expect(new Decimal("0.1").plus(new Decimal("0.2")).toString()).toBe("0.3");

    // Break-even win rate = 1 / (1 + payout) ≈ 0.54054 for 85% payout
    const breakEven = new Decimal(1).div(new Decimal(1).plus(payout));
    expect(breakEven.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString()).toBe("0.5405");
  });
});
