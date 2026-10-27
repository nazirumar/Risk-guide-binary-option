import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import {
  computeTradeProfitLoss,
  potentialProfit,
  potentialLoss,
  riskAsPercentOfBalance,
  breakEvenWinRate,
} from "@/lib/calc/trade";

/**
 * Phase 5 acceptance: "add/close/edit/delete trade keeps account balance and
 * equity history correct (unit tests)".
 *
 * The integration tests for "balance + balanceAfter stay correct" live in
 * `tests/trades-integration.test.ts` (use the real SQLite DB). This file
 * covers the pure trade math that drives those flows.
 */

describe("computeTradeProfitLoss", () => {
  it("WIN: stake * payout (positive)", () => {
    expect(computeTradeProfitLoss("100", "0.85", "WIN").toString()).toBe("85");
  });

  it("LOSS: -stake", () => {
    expect(computeTradeProfitLoss("100", "0.85", "LOSS").toString()).toBe("-100");
  });

  it("TIE: 0", () => {
    expect(computeTradeProfitLoss("100", "0.85", "TIE").toString()).toBe("0");
  });

  it("OPEN: 0 (not realized yet)", () => {
    expect(computeTradeProfitLoss("100", "0.85", "OPEN").toString()).toBe("0");
  });

  it("Decimal precision preserved", () => {
    const pl = computeTradeProfitLoss("0.10", "0.85", "WIN");
    expect(pl.toString()).toBe("0.085");
  });

  it("Decimal input works", () => {
    expect(computeTradeProfitLoss(new Decimal("100"), new Decimal("0.90"), "WIN").toString()).toBe(
      "90",
    );
  });

  it("100% payout still gives profit (1 * stake)", () => {
    expect(computeTradeProfitLoss("100", "1", "WIN").toString()).toBe("100");
  });

  it("0% payout still gives -stake on LOSS", () => {
    expect(computeTradeProfitLoss("100", "0", "LOSS").toString()).toBe("-100");
  });
});

describe("potentialProfit / potentialLoss", () => {
  it("potentialProfit = stake * payout", () => {
    expect(potentialProfit("100", "0.85").toString()).toBe("85");
  });
  it("potentialLoss = -stake", () => {
    expect(potentialLoss("100").toString()).toBe("-100");
  });
  it("Decimal precision preserved", () => {
    expect(potentialProfit("78.66", "0.7314").toString()).toBe("57.531924");
  });
});

describe("riskAsPercentOfBalance", () => {
  it("returns fraction (not %)", () => {
    // 10 / 1000 = 0.01 = 1%
    expect(riskAsPercentOfBalance("10", "1000").toString()).toBe("0.01");
  });
  it("handles small balance", () => {
    // 1 / 10 = 0.1 = 10%
    expect(riskAsPercentOfBalance("1", "10").toString()).toBe("0.1");
  });
  it("returns 0 for zero balance (no divide-by-zero)", () => {
    expect(riskAsPercentOfBalance("10", "0").toString()).toBe("0");
  });
  it("Decimal precision preserved", () => {
    // 50 / 2000 = 0.025 = 2.5%
    expect(riskAsPercentOfBalance("50", "2000").toString()).toBe("0.025");
  });
});

describe("breakEvenWinRate", () => {
  it("85% payout → ~54.05%", () => {
    expect(breakEvenWinRate("0.85").toFixed(4)).toBe("0.5405");
  });
  it("90% payout → ~52.63%", () => {
    expect(breakEvenWinRate("0.90").toFixed(4)).toBe("0.5263");
  });
  it("100% payout → 50.00%", () => {
    expect(breakEvenWinRate("1.0").toFixed(4)).toBe("0.5000");
  });
  it("0% payout → 100% win rate required", () => {
    expect(breakEvenWinRate("0").toFixed(4)).toBe("1.0000");
  });
});
