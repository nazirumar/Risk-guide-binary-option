/**
 * Phase 18 — pure-calc tests for `src/lib/calc/balance-sync.ts`.
 *
 * Covers:
 *   - `computeCheckResult`: signed difference, percent difference, MATCHED
 *     boundary (pct == tol is MATCHED; pct = tol+ε is not), divide-by-zero
 *     guard, zero-balance edge, both-zero edge.
 *   - `scoreAccuracy`: 30-day window filtering, no-data → null, only-MATCHED
 *     counts as accurate (IGNORED/ADJUSTED do NOT), floor rounding.
 *   - `suggestCauses`: each of the 5 signals (WRONG_PAYOUT, MISSING_DEPOSIT,
 *     MISSING_WITHDRAWAL, MATCHES_STAKE, GAP_DAY) plus the zero-difference
 *     short-circuit and the empty-inputs edge.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  computeCheckResult,
  scoreAccuracy,
  suggestCauses,
  type BalanceCheckLike,
  type CauseInput,
} from "@/lib/calc/balance-sync";

// ─── computeCheckResult ──────────────────────────────────────────────────────

describe("computeCheckResult — difference + tolerance", () => {
  it("returns 0 difference and MATCHED when balances are equal", () => {
    const r = computeCheckResult({
      appBalance: 1000,
      brokerBalance: 1000,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("0");
    expect(r.percentDiff.toString()).toBe("0");
    expect(r.isMatched).toBe(true);
  });

  it("returns positive difference when broker shows MORE", () => {
    const r = computeCheckResult({
      appBalance: 1000,
      brokerBalance: 1005,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("5");
    expect(r.percentDiff.toString()).toBe("0.5");
    expect(r.isMatched).toBe(true); // pct == tol is MATCHED
  });

  it("MATCHED is exclusive above the tolerance (pct = 0.6 > 0.5)", () => {
    const r = computeCheckResult({
      appBalance: 1000,
      brokerBalance: 1006,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("6");
    expect(r.percentDiff.toString()).toBe("0.6");
    expect(r.isMatched).toBe(false);
  });

  it("returns negative difference when broker shows LESS", () => {
    const r = computeCheckResult({
      appBalance: 1000,
      brokerBalance: 990,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("-10");
    expect(r.percentDiff.toString()).toBe("1");
    expect(r.isMatched).toBe(false);
  });

  it("never divides by zero — app=0, broker=10 → pct = 1000 (denom=1)", () => {
    const r = computeCheckResult({
      appBalance: 0,
      brokerBalance: 10,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("10");
    expect(r.percentDiff.toString()).toBe("1000");
    expect(r.isMatched).toBe(false);
  });

  it("both zero → MATCHED with zero percent diff", () => {
    const r = computeCheckResult({
      appBalance: 0,
      brokerBalance: 0,
      tolerancePercent: 0.5,
    });
    expect(r.difference.toString()).toBe("0");
    expect(r.percentDiff.toString()).toBe("0");
    expect(r.isMatched).toBe(true);
  });

  it("zero tolerance still MATCHES an exact-match balance", () => {
    const r = computeCheckResult({
      appBalance: 500,
      brokerBalance: 500,
      tolerancePercent: 0,
    });
    expect(r.isMatched).toBe(true);
  });

  it("zero tolerance rejects any non-zero difference", () => {
    const r = computeCheckResult({
      appBalance: 500,
      brokerBalance: 500.01,
      tolerancePercent: 0,
    });
    expect(r.isMatched).toBe(false);
  });

  it("accepts Decimal/string/number inputs interchangeably", () => {
    const r = computeCheckResult({
      appBalance: new Decimal("2000"),
      brokerBalance: "2001",
      tolerancePercent: 0.1,
    });
    expect(r.difference.toString()).toBe("1");
    // 1/2000 × 100 = 0.05%, tol = 0.1% → matched.
    expect(r.percentDiff.toString()).toBe("0.05");
    expect(r.isMatched).toBe(true);
  });

  it("decimal precision is preserved (no float drift)", () => {
    const r = computeCheckResult({
      appBalance: "1000.10",
      brokerBalance: "1000.30",
      tolerancePercent: "0.05",
    });
    // 0.20 / 1000.10 × 100 ≈ 0.01999... which is below 0.05% → MATCHED.
    expect(r.difference.toString()).toBe("0.2");
    expect(r.isMatched).toBe(true);
  });
});

// ─── scoreAccuracy ───────────────────────────────────────────────────────────

function check(resolution: BalanceCheckLike["resolution"], daysAgo: number): BalanceCheckLike {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return { resolution, checkedAt: d };
}

describe("scoreAccuracy — 30-day window", () => {
  it("returns null when the window is empty", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    expect(scoreAccuracy([], since)).toBeNull();
  });

  it("returns null when all checks fall outside the window", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const checks = [check("MATCHED", 60), check("MATCHED", 90)];
    expect(scoreAccuracy(checks, since)).toBeNull();
  });

  it("returns 100 when every check in the window is MATCHED", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const checks = [check("MATCHED", 1), check("MATCHED", 5), check("MATCHED", 10)];
    expect(scoreAccuracy(checks, since)).toBe(100);
  });

  it("does NOT count ADJUSTED or IGNORED as accurate", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const checks = [check("MATCHED", 1), check("ADJUSTED", 2), check("IGNORED", 3)];
    // 1 MATCHED out of 3 = 33.33...% → floored to 33.
    expect(scoreAccuracy(checks, since)).toBe(33);
  });

  it("floors to integer % (1/3 → 33, not 33.33)", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    expect(
      scoreAccuracy([check("MATCHED", 1), check("ADJUSTED", 1), check("IGNORED", 1)], since),
    ).toBe(33);
  });

  it("floors 2/3 → 66", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    expect(
      scoreAccuracy([check("MATCHED", 1), check("MATCHED", 2), check("ADJUSTED", 3)], since),
    ).toBe(66);
  });

  it("returns 0 when no checks are MATCHED", () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    expect(scoreAccuracy([check("ADJUSTED", 1), check("IGNORED", 2)], since)).toBe(0);
  });
});

// ─── suggestCauses ───────────────────────────────────────────────────────────

function baseInput(overrides: Partial<CauseInput> = {}): CauseInput {
  return {
    difference: "10",
    trades: [],
    transactions: [],
    commonStakes: [],
    now: new Date("2025-06-15T12:00:00Z"),
    lookbackDays: 7,
    ...overrides,
  };
}

describe("suggestCauses — possible-cause heuristics", () => {
  it("returns no suggestions when the difference is zero", () => {
    expect(suggestCauses(baseInput({ difference: "0" }))).toEqual([]);
  });

  it("returns [] only when difference is zero; non-zero difference yields at least MISSING_* or GAP_DAY", () => {
    // Zero difference short-circuits all cause analysis.
    expect(suggestCauses(baseInput({ difference: "0" }))).toEqual([]);
    // Non-zero difference with no activity still yields at least one signal
    // (MISSING_DEPOSIT when broker > 0, MISSING_WITHDRAWAL when < 0, and
    // GAP_DAY whenever any day in the window is empty).
    const out = suggestCauses(baseInput({ difference: "10" }));
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags WRONG_PAYOUT when a trade's |profitLoss| is within ±2% of |difference|", () => {
    const out = suggestCauses(
      baseInput({
        difference: "10",
        trades: [{ profitLoss: "10.1" }],
      }),
    );
    const wrong = out.find((c) => c.kind === "WRONG_PAYOUT");
    expect(wrong).toBeDefined();
    expect(wrong?.detail).toContain("10.10");
  });

  it("WRONG_PAYOUT matches within ±$2 absolute tolerance", () => {
    const out = suggestCauses(
      baseInput({
        difference: "10",
        trades: [{ profitLoss: "11.5" }],
      }),
    );
    expect(out.some((c) => c.kind === "WRONG_PAYOUT")).toBe(true);
  });

  it("WRONG_PAYOUT does NOT match when the trade's PL is far from the difference", () => {
    const out = suggestCauses(
      baseInput({
        difference: "10",
        trades: [{ profitLoss: "100" }],
      }),
    );
    expect(out.some((c) => c.kind === "WRONG_PAYOUT")).toBe(false);
  });

  it("suggests MISSING_DEPOSIT when broker shows more and no recent deposit", () => {
    const out = suggestCauses(baseInput({ difference: "50" }));
    const dep = out.find((c) => c.kind === "MISSING_DEPOSIT");
    expect(dep).toBeDefined();
    expect(dep?.detail).toContain("50");
  });

  it("suppresses MISSING_DEPOSIT when a DEPOSIT exists in the window", () => {
    const recent = new Date(Date.now() - 2 * 86400_000);
    const out = suggestCauses(
      baseInput({
        difference: "50",
        transactions: [{ type: "DEPOSIT", amount: "100", occurredAt: recent }],
      }),
    );
    expect(out.some((c) => c.kind === "MISSING_DEPOSIT")).toBe(false);
  });

  it("does NOT suggest MISSING_DEPOSIT when broker shows LESS", () => {
    const out = suggestCauses(baseInput({ difference: "-50" }));
    expect(out.some((c) => c.kind === "MISSING_DEPOSIT")).toBe(false);
  });

  it("suggests MISSING_WITHDRAWAL when broker shows less and no recent withdrawal", () => {
    const out = suggestCauses(baseInput({ difference: "-50" }));
    const wd = out.find((c) => c.kind === "MISSING_WITHDRAWAL");
    expect(wd).toBeDefined();
    expect(wd?.detail).toContain("50");
  });

  it("suppresses MISSING_WITHDRAWAL when a WITHDRAWAL exists in the window", () => {
    const recent = new Date(Date.now() - 2 * 86400_000);
    const out = suggestCauses(
      baseInput({
        difference: "-50",
        transactions: [{ type: "WITHDRAWAL", amount: "100", occurredAt: recent }],
      }),
    );
    expect(out.some((c) => c.kind === "MISSING_WITHDRAWAL")).toBe(false);
  });

  it("MATCHES_STAKE fires when |difference| is within ±5% of a recent stake", () => {
    const out = suggestCauses(baseInput({ difference: "10", commonStakes: ["10.2"] }));
    const m = out.find((c) => c.kind === "MATCHES_STAKE");
    expect(m).toBeDefined();
    expect(m?.detail).toContain("10");
  });

  it("MATCHES_STAKE also matches within ±$2 absolute", () => {
    const out = suggestCauses(baseInput({ difference: "10", commonStakes: ["11.5"] }));
    expect(out.some((c) => c.kind === "MATCHES_STAKE")).toBe(true);
  });

  it("MATCHES_STAKE does not fire on zero stakes", () => {
    const out = suggestCauses(baseInput({ difference: "10", commonStakes: ["0"] }));
    expect(out.some((c) => c.kind === "MATCHES_STAKE")).toBe(false);
  });

  it("GAP_DAY surfaces the first day in the lookback with no activity", () => {
    // Use a recent day so it falls inside the 7-day window
    const dayWithActivity = new Date(Date.now() - 1 * 86400_000);
    const out = suggestCauses(
      baseInput({
        difference: "20",
        trades: [{ profitLoss: "0", openedAt: dayWithActivity }],
      }),
    );
    // At least one gap day exists in the window (most days will be empty).
    const gap = out.find((c) => c.kind === "GAP_DAY");
    expect(gap).toBeDefined();
    expect(gap?.detail).toMatch(/^\d{4}-\d{2}-\d{2} has no trades/);
  });

  it("suppresses GAP_DAY when every day in the window has activity", () => {
    // Fill every day in the lookback with at least one transaction.
    const now = new Date("2025-06-15T12:00:00Z");
    const transactions = Array.from({ length: 7 }, (_, i) => ({
      type: "DEPOSIT" as const,
      amount: "1",
      occurredAt: new Date(now.getTime() - i * 86400_000),
    }));
    const out = suggestCauses(
      baseInput({
        difference: "20",
        transactions,
        now,
        lookbackDays: 7,
      }),
    );
    expect(out.some((c) => c.kind === "GAP_DAY")).toBe(false);
  });

  it("can produce multiple suggestion kinds at once", () => {
    const out = suggestCauses(
      baseInput({
        difference: "50",
        trades: [{ profitLoss: "50" }],
        commonStakes: ["50"],
      }),
    );
    const kinds = new Set(out.map((c) => c.kind));
    expect(kinds.has("WRONG_PAYOUT")).toBe(true);
    expect(kinds.has("MATCHES_STAKE")).toBe(true);
    expect(kinds.has("MISSING_DEPOSIT")).toBe(true); // diff > 0, no deposits
  });
});
