/**
 * Phase 21 — pure-calc tests for `src/lib/behavior/discipline.ts`.
 *
 * Covers:
 *   - DISCIPLINE_WEIGHTS sum to 100 (compile-time + runtime check).
 *   - dailyDisciplineScore: every rule individually (binary all-or-nothing),
 *     perfect day (100), perfect day minus each rule, rest-day detection,
 *     edge cases (empty trades, mixed signs).
 *   - isDisciplinedDay: rest day OR score >= 80.
 *   - disciplinedDayStreak: walks backwards, handles rest days, handles
 *     gaps (treated as rest), handles non-disciplined days (break), TZ
 *     boundaries via day-key arithmetic, lookbackDays cap.
 *   - bestStreak: longest run across history.
 *   - averageScore: plain mean with rest days included.
 *   - shiftDayKey + dayKeyInTz helpers.
 */
import { describe, it, expect } from "vitest";
import {
  DISCIPLINE_WEIGHTS,
  dailyDisciplineScore,
  isDisciplinedDay,
  disciplinedDayStreak,
  bestStreak,
  averageScore,
  shiftDayKey,
  dayKeyInTz,
  type DisciplineDayInput,
  type DailyScoreEntry,
} from "@/lib/behavior/discipline";

function baseDay(overrides: Partial<DisciplineDayInput> = {}): DisciplineDayInput {
  return {
    trades: [],
    riskPerTradeBreachedOnAnyTrade: false,
    dailyLossBreached: false,
    tradeCountBreached: false,
    lockoutOverrides: 0,
    warningOverrides: 0,
    tiltEvents: 0,
    checklistCompleted: false,
    balanceCheckDone: false,
    ...overrides,
  };
}

// ─── DISCIPLINE_WEIGHTS ───────────────────────────────────────────────────────

describe("DISCIPLINE_WEIGHTS — sum to 100", () => {
  it("weights total 100", () => {
    const total =
      DISCIPLINE_WEIGHTS.RISK_PER_TRADE +
      DISCIPLINE_WEIGHTS.NO_DAILY_BREACH +
      DISCIPLINE_WEIGHTS.NO_OVERRIDES +
      DISCIPLINE_WEIGHTS.FOLLOWED_PLAN +
      DISCIPLINE_WEIGHTS.NO_TILT +
      DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE +
      DISCIPLINE_WEIGHTS.AVOID_OVERRIDES;
    expect(total).toBe(100);
  });

  it("individual weights match the spec", () => {
    expect(DISCIPLINE_WEIGHTS.RISK_PER_TRADE).toBe(30);
    expect(DISCIPLINE_WEIGHTS.NO_DAILY_BREACH).toBe(25);
    // Phase 29: NO_OVERRIDES trimmed 15 → 10 to make room for AVOID_OVERRIDES.
    expect(DISCIPLINE_WEIGHTS.NO_OVERRIDES).toBe(10);
    expect(DISCIPLINE_WEIGHTS.FOLLOWED_PLAN).toBe(15);
    expect(DISCIPLINE_WEIGHTS.NO_TILT).toBe(10);
    expect(DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE).toBe(5);
    expect(DISCIPLINE_WEIGHTS.AVOID_OVERRIDES).toBe(5);
  });
});

// ─── dailyDisciplineScore — perfect + per-rule deductions ────────────────────

describe("dailyDisciplineScore — perfect day + per-rule deductions", () => {
  it("perfect day: all trades within limit, no breaches, no overrides, all followed plan, no tilt, checklist + balance done → 100", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [
          { id: "t1", stake: "10", followedPlan: true },
          { id: "t2", stake: "20", followedPlan: true },
        ],
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(100);
    expect(r.isRestDay).toBe(false);
    expect(r.breakdown).toHaveLength(7);
    // Every rule earned full points.
    for (const b of r.breakdown) expect(b.earned).toBe(b.total);
  });

  it("RISK_PER_TRADE breached on one trade → lose 30 pts (score=70)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [
          { id: "t1", stake: "10", followedPlan: true, breachedRiskPerTrade: false },
          { id: "t2", stake: "100", followedPlan: true, breachedRiskPerTrade: true },
        ],
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(70); // 100 - 30
    expect(r.isRestDay).toBe(false);
    const riskRule = r.breakdown.find((b) => b.rule === "RISK_PER_TRADE")!;
    expect(riskRule.earned).toBe(0);
    expect(riskRule.lost).toBe(30);
    expect(riskRule.tradeIds).toEqual(["t2"]); // only the breached trade
  });

  it("RISK_PER_TRADE: alternative trigger via riskPerTradeBreachedOnAnyTrade → lose 30", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        riskPerTradeBreachedOnAnyTrade: true,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(70);
    // No trade was explicitly marked breached, so tradeIds is the empty
    // array (the action would pre-mark each breached trade before calling
    // the pure function; here we simulate the pre-flag fallback).
    const riskRule = r.breakdown.find((b) => b.rule === "RISK_PER_TRADE")!;
    expect(riskRule.earned).toBe(0);
    expect(riskRule.lost).toBe(30);
  });

  it("NO_DAILY_BREACH: dailyLossBreached → lose 25 (score=75)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        dailyLossBreached: true,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(75);
    const breachRule = r.breakdown.find((b) => b.rule === "NO_DAILY_BREACH")!;
    expect(breachRule.earned).toBe(0);
    expect(breachRule.reason).toMatch(/daily loss limit/);
  });

  it("NO_DAILY_BREACH: tradeCountBreached → lose 25 (score=75)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        tradeCountBreached: true,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(75);
    const breachRule = r.breakdown.find((b) => b.rule === "NO_DAILY_BREACH")!;
    expect(breachRule.reason).toMatch(/max trades per day/);
  });

  it("NO_DAILY_BREACH: both daily loss + trade count → lose 25 (not double)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        dailyLossBreached: true,
        tradeCountBreached: true,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(75); // not 50 — both breaches are the same rule
    const breachRule = r.breakdown.find((b) => b.rule === "NO_DAILY_BREACH")!;
    expect(breachRule.reason).toMatch(/daily loss limit \+ max trades per day/);
  });

  it("NO_OVERRIDES: 1 lockout override → lose 10 (score=90)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        lockoutOverrides: 1,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(90);
    const overridesRule = r.breakdown.find((b) => b.rule === "NO_OVERRIDES")!;
    expect(overridesRule.earned).toBe(0);
    expect(overridesRule.reason).toMatch(/1 lockout override/);
  });

  it("NO_OVERRIDES: 1 warning override → lose 10 (score=90)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        warningOverrides: 1,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(90);
  });

  it("NO_OVERRIDES: both lockout + warning → lose 10 (not double)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        lockoutOverrides: 2,
        warningOverrides: 3,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(90); // single rule, all-or-nothing
  });

  it("AVOID_OVERRIDES: trade saved after ignoring an AVOID warning → lose 5 (score=95)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        avoidOverrides: 1,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(95);
    const avoidRule = r.breakdown.find((b) => b.rule === "AVOID_OVERRIDES")!;
    expect(avoidRule.earned).toBe(0);
    expect(avoidRule.total).toBe(DISCIPLINE_WEIGHTS.AVOID_OVERRIDES);
    expect(avoidRule.lost).toBe(DISCIPLINE_WEIGHTS.AVOID_OVERRIDES);
    expect(avoidRule.reason).toMatch(/ignoring an AVOID market warning/);
  });

  it("AVOID_OVERRIDES: configurable weight replaces the default (weight 3 → lose 3)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        avoidOverrides: 2,
        avoidOverrideWeight: 3,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(97);
    const avoidRule = r.breakdown.find((b) => b.rule === "AVOID_OVERRIDES")!;
    expect(avoidRule.total).toBe(3);
    expect(avoidRule.lost).toBe(3);
    expect(avoidRule.reason).toMatch(/2 trades saved/);
  });

  it("AVOID_OVERRIDES: weight 0 disables the deduction entirely", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        avoidOverrides: 1,
        avoidOverrideWeight: 0,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(100);
    const avoidRule = r.breakdown.find((b) => b.rule === "AVOID_OVERRIDES")!;
    expect(avoidRule.total).toBe(0);
    expect(avoidRule.earned).toBe(0);
    expect(avoidRule.lost).toBe(0);
    expect(avoidRule.reason).toMatch(/disabled in settings/);
  });

  it("AVOID_OVERRIDES: no ignored warnings → full weight earned", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        avoidOverrides: 0,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(100);
    const avoidRule = r.breakdown.find((b) => b.rule === "AVOID_OVERRIDES")!;
    expect(avoidRule.earned).toBe(avoidRule.total);
  });

  it("FOLLOWED_PLAN: one trade broke plan → lose 15 (score=85)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [
          { id: "t1", stake: "10", followedPlan: true },
          { id: "t2", stake: "20", followedPlan: false },
        ],
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(85);
    const planRule = r.breakdown.find((b) => b.rule === "FOLLOWED_PLAN")!;
    expect(planRule.earned).toBe(0);
    expect(planRule.tradeIds).toEqual(["t2"]);
  });

  it("NO_TILT: 1 tilt event → lose 10 (score=90)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        tiltEvents: 1,
        checklistCompleted: true,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(90);
    const tiltRule = r.breakdown.find((b) => b.rule === "NO_TILT")!;
    expect(tiltRule.reason).toMatch(/1 TILT event/);
  });

  it("CHECKLIST_AND_BALANCE: missing checklist → lose 5 (score=95)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        checklistCompleted: false,
        balanceCheckDone: true,
      }),
    );
    expect(r.score).toBe(95);
    const checkRule = r.breakdown.find((b) => b.rule === "CHECKLIST_AND_BALANCE")!;
    expect(checkRule.reason).toMatch(/checklist not completed/);
  });

  it("CHECKLIST_AND_BALANCE: missing balance check → lose 5 (score=95)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        checklistCompleted: true,
        balanceCheckDone: false,
      }),
    );
    expect(r.score).toBe(95);
    const checkRule = r.breakdown.find((b) => b.rule === "CHECKLIST_AND_BALANCE")!;
    expect(checkRule.reason).toMatch(/balance check/);
  });

  it("CHECKLIST_AND_BALANCE: missing both → lose 5 (not double, score=95)", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: true }],
        checklistCompleted: false,
        balanceCheckDone: false,
      }),
    );
    expect(r.score).toBe(95);
  });

  it("all rules breached → score=0", () => {
    const r = dailyDisciplineScore(
      baseDay({
        trades: [{ id: "t1", stake: "10", followedPlan: false, breachedRiskPerTrade: true }],
        dailyLossBreached: true,
        tradeCountBreached: true,
        lockoutOverrides: 1,
        warningOverrides: 1,
        avoidOverrides: 1,
        tiltEvents: 1,
        checklistCompleted: false,
        balanceCheckDone: false,
      }),
    );
    expect(r.score).toBe(0);
    expect(r.isRestDay).toBe(false);
  });
});

// ─── dailyDisciplineScore — rest days ──────────────────────────────────────────

describe("dailyDisciplineScore — rest day detection", () => {
  it("no trades + no breaches → isRestDay=true, score=95 (only CHECKLIST_AND_BALANCE lost)", () => {
    const r = dailyDisciplineScore(baseDay({}));
    expect(r.isRestDay).toBe(true);
    // RISK_PER_TRADE (vacuous 30) + NO_DAILY_BREACH (25) + NO_OVERRIDES (10) +
    // FOLLOWED_PLAN (vacuous 15) + NO_TILT (10) + AVOID_OVERRIDES (vacuous 5)
    // = 95. CHECKLIST_AND_BALANCE is 0 because the user didn't do them.
    expect(r.score).toBe(95);
  });

  it("no trades + no breaches + checklist + balance done → isRestDay=true, score=100", () => {
    const r = dailyDisciplineScore(baseDay({ checklistCompleted: true, balanceCheckDone: true }));
    expect(r.isRestDay).toBe(true);
    expect(r.score).toBe(100);
  });

  it("no trades but 1 lockout override → NOT a rest day", () => {
    const r = dailyDisciplineScore(
      baseDay({ lockoutOverrides: 1, checklistCompleted: true, balanceCheckDone: true }),
    );
    expect(r.isRestDay).toBe(false);
    // 100 - 10 (NO_OVERRIDES) = 90.
    expect(r.score).toBe(90);
  });

  it("no trades but 1 tilt event → NOT a rest day", () => {
    const r = dailyDisciplineScore(
      baseDay({ tiltEvents: 1, checklistCompleted: true, balanceCheckDone: true }),
    );
    expect(r.isRestDay).toBe(false);
    // 100 - 10 = 90.
    expect(r.score).toBe(90);
  });

  it("no trades but dailyLossBreached (from a closed-day adjustment) → NOT a rest day", () => {
    const r = dailyDisciplineScore(
      baseDay({ dailyLossBreached: true, checklistCompleted: true, balanceCheckDone: true }),
    );
    expect(r.isRestDay).toBe(false);
    // 100 - 25 = 75.
    expect(r.score).toBe(75);
  });
});

// ─── isDisciplinedDay ────────────────────────────────────────────────────────

describe("isDisciplinedDay", () => {
  it("rest day → disciplined", () => {
    expect(isDisciplinedDay(50, true)).toBe(true);
    expect(isDisciplinedDay(0, true)).toBe(true);
  });

  it("non-rest, score >= 80 → disciplined", () => {
    expect(isDisciplinedDay(80, false)).toBe(true);
    expect(isDisciplinedDay(100, false)).toBe(true);
  });

  it("non-rest, score < 80 → NOT disciplined", () => {
    expect(isDisciplinedDay(79, false)).toBe(false);
    expect(isDisciplinedDay(0, false)).toBe(false);
  });
});

// ─── disciplinedDayStreak ──────────────────────────────────────────────────────

describe("disciplinedDayStreak — rest days + gaps + TZ boundaries", () => {
  it("empty scores → 0", () => {
    expect(disciplinedDayStreak([], "2025-06-15")).toBe(0);
  });

  it("today score >= 80 → streak=1", () => {
    const scores: DailyScoreEntry[] = [{ date: "2025-06-15", score: 85, isRestDay: false }];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(1);
  });

  it("consecutive disciplined days → counts them all", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-14", score: 90, isRestDay: false },
      { date: "2025-06-15", score: 100, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(3);
  });

  it("rest day in the middle keeps the streak (no increment, no break)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-14", score: 95, isRestDay: true },
      { date: "2025-06-15", score: 90, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(2); // 15 + 13 (skipped 14)
  });

  it("gap (no entry) is treated as rest day (no break)", () => {
    // 2025-06-13 score 85, 2025-06-14 missing (gap), 2025-06-15 score 90
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-15", score: 90, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(2); // gap treated as rest
  });

  it("today is rest day → streak continues from yesterday (no increment)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-14", score: 85, isRestDay: false },
      { date: "2025-06-15", score: 95, isRestDay: true },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(1); // 14 (today skipped)
  });

  it("today not disciplined (score < 80) and not rest → break → streak=0", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-14", score: 90, isRestDay: false },
      { date: "2025-06-15", score: 50, isRestDay: false }, // not disciplined
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(0);
  });

  it("yesterday not disciplined → break → streak=1 (today only)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 90, isRestDay: false },
      { date: "2025-06-14", score: 50, isRestDay: false }, // break
      { date: "2025-06-15", score: 85, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-15")).toBe(1);
  });

  it("month-boundary TZ: walk from June 1 backwards into May", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-05-30", score: 85, isRestDay: false },
      { date: "2025-05-31", score: 90, isRestDay: false },
      { date: "2025-06-01", score: 100, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-06-01")).toBe(3);
  });

  it("year-boundary TZ: walk from 2025-01-01 backwards into 2024", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2024-12-30", score: 85, isRestDay: false },
      { date: "2024-12-31", score: 90, isRestDay: false },
      { date: "2025-01-01", score: 100, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2025-01-01")).toBe(3);
  });

  it("leap-year: walk from 2024-03-01 backwards into Feb (29 days in 2024)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2024-02-28", score: 85, isRestDay: false },
      { date: "2024-02-29", score: 90, isRestDay: false }, // 2024 is a leap year
      { date: "2024-03-01", score: 100, isRestDay: false },
    ];
    expect(disciplinedDayStreak(scores, "2024-03-01")).toBe(3);
  });

  it("lookbackDays caps the walk (300-day streak with 100-day lookback)", () => {
    // Build 300 days of disciplined scores ending today.
    const today = new Date(Date.UTC(2025, 5, 15)); // 2025-06-15
    const scores: DailyScoreEntry[] = [];
    for (let i = 0; i < 300; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      scores.push({ date: key, score: 85, isRestDay: false });
    }
    expect(disciplinedDayStreak(scores, "2025-06-15", 100)).toBe(100);
    expect(disciplinedDayStreak(scores, "2025-06-15", 365)).toBe(300);
  });
});

// ─── bestStreak ──────────────────────────────────────────────────────────────────

describe("bestStreak — longest run", () => {
  it("empty → 0", () => {
    expect(bestStreak([])).toBe(0);
  });

  it("all disciplined → equals length", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-14", score: 90, isRestDay: false },
      { date: "2025-06-15", score: 100, isRestDay: false },
    ];
    expect(bestStreak(scores)).toBe(3);
  });

  it("finds the longest run after a break", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-10", score: 85, isRestDay: false },
      { date: "2025-06-11", score: 50, isRestDay: false }, // break
      { date: "2025-06-12", score: 90, isRestDay: false },
      { date: "2025-06-13", score: 95, isRestDay: false },
      { date: "2025-06-14", score: 100, isRestDay: false },
    ];
    expect(bestStreak(scores)).toBe(3); // 12-14
  });

  it("rest days keep the streak (counted as continuation)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-14", score: 95, isRestDay: true }, // rest
      { date: "2025-06-15", score: 90, isRestDay: false },
    ];
    // 13 (1) + 14 (rest, no increment) + 15 (1) = 2 disciplined increments.
    expect(bestStreak(scores)).toBe(2);
  });

  it("multiple breaks → returns the longest", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-01", score: 90, isRestDay: false },
      { date: "2025-06-02", score: 50, isRestDay: false }, // break (best=1)
      { date: "2025-06-03", score: 85, isRestDay: false },
      { date: "2025-06-04", score: 90, isRestDay: false },
      { date: "2025-06-05", score: 100, isRestDay: false },
      { date: "2025-06-06", score: 60, isRestDay: false }, // break (best=3)
      { date: "2025-06-07", score: 85, isRestDay: false },
    ];
    expect(bestStreak(scores)).toBe(3); // 3-5
  });

  it("unsorted input → sorted defensively", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-15", score: 100, isRestDay: false },
      { date: "2025-06-13", score: 85, isRestDay: false },
      { date: "2025-06-14", score: 90, isRestDay: false },
    ];
    expect(bestStreak(scores)).toBe(3);
  });
});

// ─── averageScore ──────────────────────────────────────────────────────────────────

describe("averageScore", () => {
  it("empty → null", () => {
    expect(averageScore([])).toBeNull();
  });

  it("single day → that score (1-decimal)", () => {
    expect(averageScore([{ date: "2025-06-15", score: 85, isRestDay: false }])).toBe(85);
  });

  it("multiple days → mean (rest days included at their actual score)", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 90, isRestDay: false },
      { date: "2025-06-14", score: 95, isRestDay: true }, // rest day still scores 95
      { date: "2025-06-15", score: 80, isRestDay: false },
    ];
    expect(averageScore(scores)).toBe(88.3); // (90 + 95 + 80) / 3 = 88.33 → 88.3
  });

  it("precision: 1 decimal place", () => {
    const scores: DailyScoreEntry[] = [
      { date: "2025-06-13", score: 80, isRestDay: false },
      { date: "2025-06-14", score: 80, isRestDay: false },
      { date: "2025-06-15", score: 81, isRestDay: false },
    ];
    expect(averageScore(scores)).toBe(80.3); // 241/3 = 80.33...
  });
});

// ─── shiftDayKey + dayKeyInTz helpers ──────────────────────────────────────────────

describe("shiftDayKey — TZ-safe day arithmetic", () => {
  it("shifts backwards by 1 day", () => {
    expect(shiftDayKey("2025-06-15", -1)).toBe("2025-06-14");
  });

  it("month boundary", () => {
    expect(shiftDayKey("2025-06-01", -1)).toBe("2025-05-31");
  });

  it("year boundary", () => {
    expect(shiftDayKey("2025-01-01", -1)).toBe("2024-12-31");
  });

  it("leap year: 2024-03-01 → 2024-02-29", () => {
    expect(shiftDayKey("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("non-leap year: 2025-03-01 → 2025-02-28", () => {
    expect(shiftDayKey("2025-03-01", -1)).toBe("2025-02-28");
  });

  it("shifts forward by 1 day", () => {
    expect(shiftDayKey("2025-06-15", 1)).toBe("2025-06-16");
  });

  it("throws on invalid format", () => {
    expect(() => shiftDayKey("invalid", -1)).toThrow();
    expect(() => shiftDayKey("2025/06/15", -1)).toThrow();
  });
});

describe("dayKeyInTz — TZ day key", () => {
  it("UTC", () => {
    const d = new Date("2025-06-15T12:00:00Z");
    expect(dayKeyInTz(d, "UTC")).toBe("2025-06-15");
  });

  it("Africa/Lagos (UTC+1)", () => {
    // 2025-06-15T22:30:00Z is 2025-06-15T23:30:00+01:00 in Lagos — same day.
    const d = new Date("2025-06-15T22:30:00Z");
    expect(dayKeyInTz(d, "Africa/Lagos")).toBe("2025-06-15");
  });

  it("TZ boundary: 22:30 UTC = 23:30 in Lagos (next day in UTC but same day in Lagos)", () => {
    // 2025-06-15T22:30:00Z → 2025-06-15T23:30:00+01:00 → day key 2025-06-15
    const d = new Date("2025-06-15T22:30:00Z");
    expect(dayKeyInTz(d, "Africa/Lagos")).toBe("2025-06-15");
  });

  it("TZ boundary: 23:30 UTC = next day in Lagos (00:30 of next day)", () => {
    // 2025-06-15T23:30:00Z → 2025-06-16T00:30:00+01:00 → day key 2025-06-16
    const d = new Date("2025-06-15T23:30:00Z");
    expect(dayKeyInTz(d, "Africa/Lagos")).toBe("2025-06-16");
  });

  it("invalid tz → fallback to UTC slice", () => {
    const d = new Date("2025-06-15T12:00:00Z");
    expect(dayKeyInTz(d, "Invalid/Timezone")).toBe("2025-06-15");
  });
});
