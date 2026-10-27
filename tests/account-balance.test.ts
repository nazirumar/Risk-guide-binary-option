import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  signedTransactionAmount,
  recomputeAccountBalance,
  equityWalk,
  todayPL,
  reconcileDifference,
  withdrawalWouldExceedBalance,
} from "@/lib/calc/account-balance";

/**
 * Phase 4 acceptance: "Unit tests for the balance calculation."
 *
 * These tests cover the pure math; the server-action tests (in
 * `tests/accounts-integration.test.ts`) cover the atomic persistence +
 * cross-user isolation.
 */

describe("signedTransactionAmount", () => {
  it("DEPOSIT is positive", () => {
    expect(signedTransactionAmount({ type: "DEPOSIT", amount: "100" }).toString()).toBe("100");
  });
  it("WITHDRAWAL is negative", () => {
    expect(signedTransactionAmount({ type: "WITHDRAWAL", amount: "100" }).toString()).toBe("-100");
  });
  it("BONUS is positive", () => {
    expect(signedTransactionAmount({ type: "BONUS", amount: "50" }).toString()).toBe("50");
  });
  it("ADJUSTMENT preserves sign (positive)", () => {
    expect(signedTransactionAmount({ type: "ADJUSTMENT", amount: "12.34" }).toString()).toBe(
      "12.34",
    );
  });
  it("ADJUSTMENT preserves sign (negative)", () => {
    expect(signedTransactionAmount({ type: "ADJUSTMENT", amount: "-12.34" }).toString()).toBe(
      "-12.34",
    );
  });
  it("preserves decimal precision (no float drift)", () => {
    expect(
      signedTransactionAmount({ type: "DEPOSIT", amount: "0.10" }).plus("0.20").toString(),
    ).toBe("0.3");
  });
  it("accepts Decimal input", () => {
    expect(
      signedTransactionAmount({ type: "DEPOSIT", amount: new Decimal("99.99") }).toString(),
    ).toBe("99.99");
  });
  it("accepts number input", () => {
    expect(signedTransactionAmount({ type: "DEPOSIT", amount: 42 }).toString()).toBe("42");
  });
});

describe("recomputeAccountBalance", () => {
  it("returns starting balance when no transactions or trades", () => {
    expect(recomputeAccountBalance("1000", [], []).toString()).toBe("1000");
  });

  it("adds a deposit", () => {
    const bal = recomputeAccountBalance("1000", [{ type: "DEPOSIT", amount: "500" }], []);
    expect(bal.toString()).toBe("1500");
  });

  it("subtracts a withdrawal", () => {
    const bal = recomputeAccountBalance("1000", [{ type: "WITHDRAWAL", amount: "200" }], []);
    expect(bal.toString()).toBe("800");
  });

  it("adds a bonus", () => {
    const bal = recomputeAccountBalance("1000", [{ type: "BONUS", amount: "50" }], []);
    expect(bal.toString()).toBe("1050");
  });

  it("applies a positive adjustment", () => {
    const bal = recomputeAccountBalance("1000", [{ type: "ADJUSTMENT", amount: "12.34" }], []);
    expect(bal.toString()).toBe("1012.34");
  });

  it("applies a negative adjustment", () => {
    const bal = recomputeAccountBalance("1000", [{ type: "ADJUSTMENT", amount: "-12.34" }], []);
    expect(bal.toString()).toBe("987.66");
  });

  it("mixes all 4 transaction types", () => {
    const bal = recomputeAccountBalance(
      "1000",
      [
        { type: "DEPOSIT", amount: "500" },
        { type: "WITHDRAWAL", amount: "200" },
        { type: "BONUS", amount: "50" },
        { type: "ADJUSTMENT", amount: "-12.34" },
      ],
      [],
    );
    expect(bal.toString()).toBe("1337.66");
  });

  it("adds trade P/L (WIN)", () => {
    const bal = recomputeAccountBalance("1000", [], [{ profitLoss: "85" }]);
    expect(bal.toString()).toBe("1085");
  });

  it("subtracts trade P/L (LOSS)", () => {
    const bal = recomputeAccountBalance("1000", [], [{ profitLoss: "-100" }]);
    expect(bal.toString()).toBe("900");
  });

  it("ignores TIE (P/L=0)", () => {
    const bal = recomputeAccountBalance("1000", [], [{ profitLoss: "0" }]);
    expect(bal.toString()).toBe("1000");
  });

  it("combines transactions and trades", () => {
    const bal = recomputeAccountBalance(
      "10000",
      [
        { type: "DEPOSIT", amount: "10000" },
        { type: "WITHDRAWAL", amount: "100" },
        { type: "BONUS", amount: "50" },
      ],
      [
        { profitLoss: "-78.66" }, // loss
        { profitLoss: "57.53" }, // win
        { profitLoss: "-78.66" }, // loss
      ],
    );
    // 10000 + (10000 - 100 + 50) + (-78.66 + 57.53 - 78.66) = 10000 + 9950 - 99.79 = 19850.21
    expect(bal.toString()).toBe("19850.21");
  });

  it("decimal precision (no float drift)", () => {
    const bal = recomputeAccountBalance(
      "0.10",
      [{ type: "DEPOSIT", amount: "0.20" }],
      [{ profitLoss: "0.10" }],
    );
    expect(bal.toString()).toBe("0.4");
  });

  it("returns negative balance when withdrawals exceed deposits", () => {
    const bal = recomputeAccountBalance("0", [{ type: "WITHDRAWAL", amount: "100" }], []);
    expect(bal.toString()).toBe("-100");
  });
});

describe("equityWalk", () => {
  it("returns [] for no trades", () => {
    expect(equityWalk("1000", [])).toEqual([]);
  });

  it("computes running balance in chronological order", () => {
    const trades = [
      { profitLoss: "100", openedAt: new Date("2026-01-02T10:00:00Z") },
      { profitLoss: "-50", openedAt: new Date("2026-01-01T10:00:00Z") },
      { profitLoss: "200", openedAt: new Date("2026-01-03T10:00:00Z") },
    ];
    // Sorted by openedAt → -50 first, then +100, then +200
    // start=1000 → 950 → 1050 → 1250
    expect(equityWalk("1000", trades).map((d) => d.toString())).toEqual(["950", "1050", "1250"]);
  });

  it("handles all-zero P/L trades", () => {
    const trades = [{ profitLoss: "0" }, { profitLoss: "0" }];
    expect(equityWalk("500", trades).map((d) => d.toString())).toEqual(["500", "500"]);
  });
});

describe("todayPL", () => {
  // Use Date.now() mocks by filtering on openedAt directly.
  it("sums P/L of trades opened today", () => {
    const today = new Date();
    const trades = [
      { profitLoss: "100", openedAt: today },
      { profitLoss: "-50", openedAt: today },
    ];
    expect(todayPL(trades).toString()).toBe("50");
  });

  it("excludes trades from yesterday", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const today = new Date();
    const trades = [
      { profitLoss: "100", openedAt: today },
      { profitLoss: "-50", openedAt: yesterday },
    ];
    expect(todayPL(trades).toString()).toBe("100");
  });

  it("returns 0 if no trades today", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(todayPL([{ profitLoss: "100", openedAt: yesterday }]).toString()).toBe("0");
  });
});

describe("reconcileDifference", () => {
  it("positive when broker shows more than our books", () => {
    expect(reconcileDifference("1000", "1050").toString()).toBe("50");
  });
  it("negative when broker shows less than our books", () => {
    expect(reconcileDifference("1000", "950").toString()).toBe("-50");
  });
  it("zero when matched", () => {
    expect(reconcileDifference("1000", "1000").toString()).toBe("0");
  });
  it("decimal precision preserved", () => {
    expect(reconcileDifference("1000.10", "1000.20").toString()).toBe("0.1");
  });
});

describe("withdrawalWouldExceedBalance", () => {
  it("true when withdrawal > balance", () => {
    expect(withdrawalWouldExceedBalance("100", "200")).toBe(true);
  });
  it("false when withdrawal = balance", () => {
    expect(withdrawalWouldExceedBalance("100", "100")).toBe(false);
  });
  it("false when withdrawal < balance", () => {
    expect(withdrawalWouldExceedBalance("100", "50")).toBe(false);
  });
});
