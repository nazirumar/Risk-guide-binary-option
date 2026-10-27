import { describe, it, expect } from "vitest";
import { compoundingPlan, checkRealisticGoal } from "@/lib/calc/compounding";

describe("compoundingPlan", () => {
  it("projects simple compounding (no withdrawal)", () => {
    const r = compoundingPlan({ startBalance: 1000, dailyGrowthPercent: 0.02, numDays: 5 });
    expect(r.rows.length).toBe(5);
    expect(r.rows[0].day).toBe(1);
    expect(r.rows[0].startBalance).toBe(1000);
    expect(r.rows[0].growth).toBeCloseTo(20, 6);
    expect(r.rows[0].withdrawal).toBe(0);
    expect(r.rows[0].endBalance).toBeCloseTo(1020, 6);
    expect(r.rows[1].startBalance).toBeCloseTo(1020, 6);
    expect(r.rows[1].growth).toBeCloseTo(20.4, 4);
    expect(r.finalBalance).toBeCloseTo(1000 * Math.pow(1.02, 5), 2);
    expect(r.totalWithdrawn).toBe(0);
  });

  it("applies percent-of-profit withdrawal", () => {
    const r = compoundingPlan({
      startBalance: 1000,
      dailyGrowthPercent: 0.02,
      numDays: 3,
      withdrawalRule: { type: "percentOfProfit", percent: 0.5 },
    });
    // Day 1: growth=20, withdrawal=10, end=1010
    expect(r.rows[0]).toEqual({
      day: 1,
      startBalance: 1000,
      growth: 20,
      withdrawal: 10,
      endBalance: 1010,
    });
    // Day 2: start=1010, growth=20.2, withdrawal=10.1, end=1020.1
    expect(r.rows[1].startBalance).toBe(1010);
    expect(r.rows[1].growth).toBeCloseTo(20.2, 6);
    expect(r.rows[1].withdrawal).toBeCloseTo(10.1, 6);
    expect(r.totalWithdrawn).toBeCloseTo(30.3, 2);
  });

  it("applies fixed withdrawal (capped at daily growth)", () => {
    const r = compoundingPlan({
      startBalance: 1000,
      dailyGrowthPercent: 0.01, // 1% = $10/day on $1000
      numDays: 2,
      withdrawalRule: { type: "fixed", amount: 15 },
    });
    // Day 1: growth=10, withdrawal=min(15,10)=10, end=1000
    expect(r.rows[0]).toEqual({
      day: 1,
      startBalance: 1000,
      growth: 10,
      withdrawal: 10,
      endBalance: 1000,
    });
    // Day 2: start=1000, growth=10, withdrawal=10, end=1000 (no compounding because we withdraw all)
    expect(r.rows[1].startBalance).toBe(1000);
  });

  it("returns empty for invalid inputs", () => {
    expect(compoundingPlan({ startBalance: 0, dailyGrowthPercent: 0.02, numDays: 5 }).rows).toEqual(
      [],
    );
    expect(compoundingPlan({ startBalance: 1000, dailyGrowthPercent: 0, numDays: 5 }).rows).toEqual(
      [],
    );
    expect(
      compoundingPlan({ startBalance: 1000, dailyGrowthPercent: 0.02, numDays: 0 }).rows,
    ).toEqual([]);
  });

  it("10% daily for 30 days → ~17x growth", () => {
    const r = compoundingPlan({ startBalance: 1000, dailyGrowthPercent: 0.1, numDays: 30 });
    // 1000 × 1.1^30 ≈ 17449
    expect(r.finalBalance).toBeCloseTo(1000 * Math.pow(1.1, 30), 0);
    expect(r.totalGrowthPercent).toBeCloseTo(Math.pow(1.1, 30) - 1, 4);
  });

  it("2% daily for 30 days → ~1.81x growth", () => {
    const r = compoundingPlan({ startBalance: 1000, dailyGrowthPercent: 0.02, numDays: 30 });
    // 1000 × 1.02^30 ≈ 1811
    expect(r.finalBalance).toBeCloseTo(1000 * Math.pow(1.02, 30), 0);
  });
});

describe("checkRealisticGoal", () => {
  it("returns realistic=true for 2% daily growth over 30 days", () => {
    const r = checkRealisticGoal({ currentBalance: 1000, targetAmount: 1811, daysToTarget: 30 });
    expect(r.realistic).toBe(true);
    expect(r.requiredDailyGrowthPercent).toBeCloseTo(0.02, 3);
    expect(r.warning).toBeNull();
  });

  it("returns realistic=false for >10% daily growth", () => {
    const r = checkRealisticGoal({ currentBalance: 1000, targetAmount: 10000, daysToTarget: 10 });
    // 1000 → 10000 in 10 days = ~58% daily growth
    expect(r.realistic).toBe(false);
    expect(r.requiredDailyGrowthPercent).toBeGreaterThan(0.1);
    expect(r.warning).toContain("unsustainable");
  });

  it("returns warning for 5-10% daily growth (aggressive but possible)", () => {
    const r = checkRealisticGoal({ currentBalance: 1000, targetAmount: 2000, daysToTarget: 10 });
    // 1000 → 2000 in 10 days = ~7.2% daily
    expect(r.requiredDailyGrowthPercent).toBeGreaterThan(0.05);
    expect(r.requiredDailyGrowthPercent).toBeLessThan(0.1);
    expect(r.warning).toContain("aggressive");
  });

  it("returns invalid for zero/negative inputs", () => {
    expect(
      checkRealisticGoal({ currentBalance: 0, targetAmount: 1000, daysToTarget: 30 }).realistic,
    ).toBe(false);
    expect(
      checkRealisticGoal({ currentBalance: 1000, targetAmount: 0, daysToTarget: 30 }).realistic,
    ).toBe(false);
    expect(
      checkRealisticGoal({ currentBalance: 1000, targetAmount: 1000, daysToTarget: 0 }).realistic,
    ).toBe(false);
  });
});
