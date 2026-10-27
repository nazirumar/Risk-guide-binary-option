/**
 * Phase 10 — Compounding planner + realistic-goal checker.
 *
 * Pure functions (no DB, no side effects) — tested via
 * tests/calc/compounding.test.ts.
 *
 * PROJECT_RULES.md rule #2: pure functions in /src/lib/calc.
 */

export type WithdrawalRule =
  | { type: "none" }
  | { type: "percentOfProfit"; percent: number } // e.g., 0.5 = withdraw 50% of daily profit
  | { type: "fixed"; amount: number }; // withdraw fixed $X per day

export type CompoundingRow = {
  day: number; // 1-indexed
  startBalance: number;
  growth: number; // daily growth = startBalance × dailyGrowthPercent
  withdrawal: number; // amount withdrawn (0 if no withdrawal rule)
  endBalance: number; // startBalance + growth - withdrawal
};

export type CompoundingResult = {
  rows: CompoundingRow[];
  finalBalance: number;
  totalGrowth: number;
  totalWithdrawn: number;
  totalGrowthPercent: number;
};

/**
 * Project balance growth over N days with a daily growth % and optional
 * withdrawal rule.
 *
 *   dailyGrowthPercent: fraction (0.02 = 2% per day)
 *   numDays: how many days to project
 *   withdrawalRule: how to handle profits (none / % of profit / fixed $)
 *
 * Each day:
 *   growth = startBalance × dailyGrowthPercent
 *   withdrawal = depends on rule
 *   endBalance = startBalance + growth - withdrawal
 *   nextDay's startBalance = endBalance (compounds)
 *
 * If withdrawalRule is "percentOfProfit", withdrawal = growth × percent.
 * If "fixed", withdrawal = min(amount, growth) (can't withdraw more than you
 * earned that day).
 */
export function compoundingPlan(opts: {
  startBalance: number;
  dailyGrowthPercent: number;
  numDays: number;
  withdrawalRule?: WithdrawalRule;
}): CompoundingResult {
  const { startBalance, dailyGrowthPercent, numDays } = opts;
  const rule = opts.withdrawalRule ?? { type: "none" };

  if (startBalance <= 0 || dailyGrowthPercent <= 0 || numDays <= 0) {
    return {
      rows: [],
      finalBalance: startBalance,
      totalGrowth: 0,
      totalWithdrawn: 0,
      totalGrowthPercent: 0,
    };
  }

  const rows: CompoundingRow[] = [];
  let balance = startBalance;
  let totalGrowth = 0;
  let totalWithdrawn = 0;

  for (let day = 1; day <= numDays; day++) {
    const dayStart = balance;
    const growth = dayStart * dailyGrowthPercent;
    let withdrawal = 0;
    if (rule.type === "percentOfProfit") {
      withdrawal = growth * rule.percent;
    } else if (rule.type === "fixed") {
      withdrawal = Math.min(rule.amount, growth); // can't withdraw more than earned
    }
    const endBalance = dayStart + growth - withdrawal;
    rows.push({
      day,
      startBalance: dayStart,
      growth,
      withdrawal,
      endBalance,
    });
    balance = endBalance;
    totalGrowth += growth;
    totalWithdrawn += withdrawal;
  }

  return {
    rows,
    finalBalance: balance,
    totalGrowth,
    totalWithdrawn,
    totalGrowthPercent: startBalance > 0 ? (balance - startBalance) / startBalance : 0,
  };
}

export type RealisticCheck = {
  realistic: boolean;
  requiredDailyGrowthPercent: number;
  warning: string | null;
};

/**
 * Check if a goal is realistic. Returns the required daily growth % and a
 * warning if the target requires >10% daily growth (unsustainable).
 *
 *   currentBalance: the user's current balance
 *   targetAmount: the goal's target (e.g., $2000)
 *   daysToTarget: how many days until the goal's endDate
 *
 * requiredDailyGrowthPercent = (target / current)^(1/days) - 1
 *
 * If daysToTarget ≤ 0 or currentBalance ≤ 0, returns { realistic: false, ... }.
 */
export function checkRealisticGoal(opts: {
  currentBalance: number;
  targetAmount: number;
  daysToTarget: number;
}): RealisticCheck {
  const { currentBalance, targetAmount, daysToTarget } = opts;
  if (currentBalance <= 0 || daysToTarget <= 0 || targetAmount <= 0) {
    return {
      realistic: false,
      requiredDailyGrowthPercent: 0,
      warning: "Invalid inputs — balance, target, or days must be positive.",
    };
  }
  // Required daily growth = (target/current)^(1/days) - 1
  const ratio = targetAmount / currentBalance;
  const requiredDailyGrowth = Math.pow(ratio, 1 / daysToTarget) - 1;

  let warning: string | null = null;
  let realistic = true;
  if (requiredDailyGrowth > 0.1) {
    realistic = false;
    warning = `This goal requires ${(requiredDailyGrowth * 100).toFixed(1)}% daily growth — that's unsustainable. Professional traders aim for 1-3% daily. Consider extending the deadline or lowering the target.`;
  } else if (requiredDailyGrowth > 0.05) {
    warning = `This goal requires ${(requiredDailyGrowth * 100).toFixed(1)}% daily growth — aggressive but possible with discipline. Most professionals target 1-3% daily.`;
  }

  return { realistic, requiredDailyGrowthPercent: requiredDailyGrowth, warning };
}
