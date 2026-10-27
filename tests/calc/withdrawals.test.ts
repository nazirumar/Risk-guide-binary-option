/**
 * Phase 19 — pure-calc tests for `src/lib/calc/withdrawals.ts`.
 *
 * Covers:
 *   - `computeProfitSinceBaseline`: all 3 baselines, fallbacks when
 *     lastWd/hwm are null, drawdown case (negative profit).
 *   - `recommendWithdrawalAmount`: all 3 rule types, no-profit short-circuit,
 *     FIXED_AMOUNT capped to available profit, BALANCE_ABOVE_THRESHOLD below
 *     threshold → 0.
 *   - `trackHighWaterMark`: null seed, peak update, no update when below.
 *   - `isWithdrawalDue`: never-fired, same-day (DAILY), yesterday,
 *     same-week (WEEKLY), last-week, same-month (MONTHLY), last-month.
 *   - `bankedVsAtRisk`: net-down vs net-up vs exactly-even.
 *   - `isBigWinDay`: positive PL ≥ threshold, negative PL, threshold null,
 *     zero balance edge.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  computeProfitSinceBaseline,
  recommendWithdrawalAmount,
  trackHighWaterMark,
  isWithdrawalDue,
  bankedVsAtRisk,
  isBigWinDay,
} from "@/lib/calc/withdrawals";

// ─── computeProfitSinceBaseline ─────────────────────────────────────────────

describe("computeProfitSinceBaseline — three baselines + fallbacks", () => {
  it("STARTING_BALANCE → current − starting", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1200",
      baseline: "STARTING_BALANCE",
    });
    expect(p.toString()).toBe("200");
  });

  it("STARTING_BALANCE with drawdown → negative profit", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "850",
      baseline: "STARTING_BALANCE",
    });
    expect(p.toString()).toBe("-150");
  });

  it("LAST_WITHDRAWAL → current − lastWithdrawalBalance", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1200",
      lastWithdrawalBalance: "1100",
      baseline: "LAST_WITHDRAWAL",
    });
    expect(p.toString()).toBe("100");
  });

  it("LAST_WITHDRAWAL with null anchor → falls back to starting balance", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1200",
      lastWithdrawalBalance: null,
      baseline: "LAST_WITHDRAWAL",
    });
    expect(p.toString()).toBe("200");
  });

  it("HIGH_WATER_MARK → current − highWaterMark", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1200",
      highWaterMark: "1300",
      baseline: "HIGH_WATER_MARK",
    });
    expect(p.toString()).toBe("-100"); // in drawdown vs peak
  });

  it("HIGH_WATER_MARK with null mark → falls back to starting balance", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: "1000",
      currentBalance: "1200",
      highWaterMark: null,
      baseline: "HIGH_WATER_MARK",
    });
    expect(p.toString()).toBe("200");
  });

  it("accepts Decimal|string|number inputs interchangeably", () => {
    const p = computeProfitSinceBaseline({
      startingBalance: new Decimal("1000"),
      currentBalance: "1500",
      baseline: "STARTING_BALANCE",
    });
    expect(p.toString()).toBe("500");
  });
});

// ─── recommendWithdrawalAmount ──────────────────────────────────────────────

describe("recommendWithdrawalAmount — three rule types", () => {
  it("PERCENT_OF_PROFIT: 20% of $200 profit = $40", () => {
    const a = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "20",
      profitSinceBaseline: "200",
      currentBalance: "1200",
    });
    expect(a.toString()).toBe("40");
  });

  it("PERCENT_OF_PROFIT with negative profit → 0 (no withdrawal in drawdown)", () => {
    const a = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "20",
      profitSinceBaseline: "-100",
      currentBalance: "900",
    });
    expect(a.toString()).toBe("0");
  });

  it("PERCENT_OF_PROFIT with zero profit → 0", () => {
    const a = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "20",
      profitSinceBaseline: "0",
      currentBalance: "1000",
    });
    expect(a.toString()).toBe("0");
  });

  it("PERCENT_OF_PROFIT with 50% of $200 profit = $100", () => {
    const a = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "50",
      profitSinceBaseline: "200",
      currentBalance: "1200",
    });
    expect(a.toString()).toBe("100");
  });

  it("FIXED_AMOUNT: $50 fixed, profit $200 → recommend $50", () => {
    const a = recommendWithdrawalAmount({
      type: "FIXED_AMOUNT",
      value: "50",
      profitSinceBaseline: "200",
      currentBalance: "1200",
    });
    expect(a.toString()).toBe("50");
  });

  it("FIXED_AMOUNT: $50 fixed but profit only $30 → recommend $30 (cap to profit)", () => {
    const a = recommendWithdrawalAmount({
      type: "FIXED_AMOUNT",
      value: "50",
      profitSinceBaseline: "30",
      currentBalance: "1030",
    });
    expect(a.toString()).toBe("30");
  });

  it("FIXED_AMOUNT with zero profit → 0", () => {
    const a = recommendWithdrawalAmount({
      type: "FIXED_AMOUNT",
      value: "50",
      profitSinceBaseline: "0",
      currentBalance: "1000",
    });
    expect(a.toString()).toBe("0");
  });

  it("BALANCE_ABOVE_THRESHOLD: threshold 1000, balance 1200 → recommend 200", () => {
    const a = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1000",
      profitSinceBaseline: "200",
      currentBalance: "1200",
    });
    expect(a.toString()).toBe("200");
  });

  it("BALANCE_ABOVE_THRESHOLD: balance below threshold → 0", () => {
    const a = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1000",
      profitSinceBaseline: "0",
      currentBalance: "950",
    });
    expect(a.toString()).toBe("0");
  });

  it("BALANCE_ABOVE_THRESHOLD: balance exactly equals threshold → 0", () => {
    const a = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1000",
      profitSinceBaseline: "0",
      currentBalance: "1000",
    });
    expect(a.toString()).toBe("0");
  });

  it("BALANCE_ABOVE_THRESHOLD: balance above threshold but profit-since-baseline is negative → 0 (drawdown guard)", () => {
    const a = recommendWithdrawalAmount({
      type: "BALANCE_ABOVE_THRESHOLD",
      value: "1000",
      profitSinceBaseline: "-50",
      currentBalance: "1050",
    });
    expect(a.toString()).toBe("0");
  });

  it("decimal precision preserved: 33.33% of $300 profit = $99.99", () => {
    const a = recommendWithdrawalAmount({
      type: "PERCENT_OF_PROFIT",
      value: "33.33",
      profitSinceBaseline: "300",
      currentBalance: "1300",
    });
    expect(a.toString()).toBe("99.99");
  });
});

// ─── trackHighWaterMark ──────────────────────────────────────────────────────

describe("trackHighWaterMark — peak balance tracking", () => {
  it("null seed → returns the current balance as the new mark", () => {
    expect(trackHighWaterMark(null, "1000").toString()).toBe("1000");
  });

  it("current balance exceeds mark → returns the new balance", () => {
    expect(trackHighWaterMark("1000", "1200").toString()).toBe("1200");
  });

  it("current balance below mark → returns the existing mark (no update)", () => {
    expect(trackHighWaterMark("1300", "1100").toString()).toBe("1300");
  });

  it("current balance equals mark → returns the same value", () => {
    expect(trackHighWaterMark("1000", "1000").toString()).toBe("1000");
  });

  it("accepts Decimal inputs", () => {
    expect(trackHighWaterMark(new Decimal("1000"), new Decimal("1500")).toString()).toBe("1500");
  });
});

// ─── isWithdrawalDue ─────────────────────────────────────────────────────────

describe("isWithdrawalDue — frequency gate", () => {
  const NOW = new Date("2025-06-15T12:00:00Z"); // Sunday

  it("never fired → due regardless of frequency", () => {
    expect(isWithdrawalDue({ frequency: "DAILY", lastTriggeredAt: null, now: NOW })).toBe(true);
    expect(isWithdrawalDue({ frequency: "WEEKLY", lastTriggeredAt: null, now: NOW })).toBe(true);
    expect(
      isWithdrawalDue({
        frequency: "MONTHLY",
        lastTriggeredAt: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("DAILY: same day → not due", () => {
    const last = new Date("2025-06-15T03:00:00Z"); // earlier today
    expect(isWithdrawalDue({ frequency: "DAILY", lastTriggeredAt: last, now: NOW })).toBe(false);
  });

  it("DAILY: yesterday → due", () => {
    const last = new Date("2025-06-14T23:00:00Z"); // yesterday
    expect(isWithdrawalDue({ frequency: "DAILY", lastTriggeredAt: last, now: NOW })).toBe(true);
  });

  it("DAILY: same day boundary — earlier this morning not due", () => {
    // Just before UTC midnight → still same day as NOW.
    const last = new Date("2025-06-15T23:59:00Z");
    expect(isWithdrawalDue({ frequency: "DAILY", lastTriggeredAt: last, now: NOW })).toBe(false);
  });

  it("WEEKLY: earlier this week → not due", () => {
    // Sunday June 15 2025 → ISO week 24. Monday June 9 is the start of W24.
    const last = new Date("2025-06-09T12:00:00Z"); // Monday same week
    expect(isWithdrawalDue({ frequency: "WEEKLY", lastTriggeredAt: last, now: NOW })).toBe(false);
  });

  it("WEEKLY: last week → due", () => {
    // Sunday June 1 → previous week.
    const last = new Date("2025-06-01T12:00:00Z");
    expect(isWithdrawalDue({ frequency: "WEEKLY", lastTriggeredAt: last, now: NOW })).toBe(true);
  });

  it("MONTHLY: earlier this month → not due", () => {
    const last = new Date("2025-06-01T12:00:00Z");
    expect(
      isWithdrawalDue({
        frequency: "MONTHLY",
        lastTriggeredAt: last,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("MONTHLY: last month → due", () => {
    const last = new Date("2025-05-31T12:00:00Z");
    expect(
      isWithdrawalDue({
        frequency: "MONTHLY",
        lastTriggeredAt: last,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("MONTHLY: same month, different year → due", () => {
    const last = new Date("2024-06-15T12:00:00Z"); // June 2024
    expect(
      isWithdrawalDue({
        frequency: "MONTHLY",
        lastTriggeredAt: last,
        now: NOW, // June 2025
      }),
    ).toBe(true);
  });
});

// ─── bankedVsAtRisk ──────────────────────────────────────────────────────────

describe("bankedVsAtRisk — net banked profit vs at-risk capital", () => {
  it("net-down: more deposited than withdrawn → negative banked", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "1000",
      totalWithdrawn: "300",
      currentBalance: "850",
    });
    expect(r.banked.toString()).toBe("-700"); // 300 - 1000
    expect(r.atRisk.toString()).toBe("850");
  });

  it("net-up: more withdrawn than deposited → positive banked", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "1000",
      totalWithdrawn: "1300",
      currentBalance: "850",
    });
    expect(r.banked.toString()).toBe("300"); // 1300 - 1000
    expect(r.atRisk.toString()).toBe("850");
  });

  it("exactly even: withdrawn equals deposited → banked = 0", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "1000",
      totalWithdrawn: "1000",
      currentBalance: "1000",
    });
    expect(r.banked.toString()).toBe("0");
    expect(r.atRisk.toString()).toBe("1000");
  });

  it("no withdrawals yet → banked = -deposited (all principal still in)", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "500",
      totalWithdrawn: "0",
      currentBalance: "500",
    });
    expect(r.banked.toString()).toBe("-500");
    expect(r.atRisk.toString()).toBe("500");
  });

  it("decimal precision preserved (no float drift)", () => {
    const r = bankedVsAtRisk({
      totalDeposited: "100.10",
      totalWithdrawn: "100.20",
      currentBalance: "100.05",
    });
    expect(r.banked.toString()).toBe("0.1"); // 100.20 - 100.10
    expect(r.atRisk.toString()).toBe("100.05");
  });
});

// ─── isBigWinDay ─────────────────────────────────────────────────────────────

describe("isBigWinDay — big-win-day threshold", () => {
  it("todayPL exactly equals threshold percent of balance → true (≥)", () => {
    expect(isBigWinDay({ todayPL: "200", balance: "1000", thresholdPercent: "20" })).toBe(true);
  });

  it("todayPL below threshold → false", () => {
    expect(isBigWinDay({ todayPL: "150", balance: "1000", thresholdPercent: "20" })).toBe(false);
  });

  it("todayPL above threshold → true", () => {
    expect(isBigWinDay({ todayPL: "300", balance: "1000", thresholdPercent: "20" })).toBe(true);
  });

  it("negative todayPL → false (big LOSS, not big WIN)", () => {
    expect(isBigWinDay({ todayPL: "-300", balance: "1000", thresholdPercent: "20" })).toBe(false);
  });

  it("zero todayPL → false", () => {
    expect(isBigWinDay({ todayPL: "0", balance: "1000", thresholdPercent: "20" })).toBe(false);
  });

  it("null threshold → false (disabled)", () => {
    expect(isBigWinDay({ todayPL: "500", balance: "1000", thresholdPercent: null })).toBe(false);
  });

  it("zero balance → uses denom=1 (200/1×100=20000 ≥ 20 → true)", () => {
    expect(isBigWinDay({ todayPL: "200", balance: "0", thresholdPercent: "20" })).toBe(true);
  });

  it("accepts Decimal inputs", () => {
    expect(
      isBigWinDay({
        todayPL: new Decimal("200"),
        balance: new Decimal("1000"),
        thresholdPercent: new Decimal("20"),
      }),
    ).toBe(true);
  });
});
