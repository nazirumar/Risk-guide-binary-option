/**
 * Pure calc helpers for Phase 19 — Withdrawal Rules & Profit-Taking.
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib/calc` as pure,
 * unit-tested functions. rule #1: money is Decimal — never Float.)
 *
 * Six exported pure functions:
 *
 *   1. `computeProfitSinceBaseline` — given the rule's baseline choice, the
 *      account's starting balance, current balance, last-withdrawal anchor,
 *      and high-water mark, return the profit available for withdrawal.
 *      Negative when the account is in drawdown vs the baseline.
 *
 *   2. `recommendWithdrawalAmount` — apply the rule's `type` + `value` to the
 *      profit-since-baseline (and current balance, for the threshold type).
 *      Always returns a non-negative Decimal; 0 when no profit or rule won't
 *      fire (e.g. balance below threshold).
 *
 *   3. `trackHighWaterMark` — given the current mark (possibly null) and the
 *      current balance, return the new peak. Pure — caller persists it.
 *
 *   4. `isWithdrawalDue` — given the rule's frequency + lastTriggeredAt +
 *      now, return whether the rule should fire a reminder again. Uses the
 *      user's wall-clock day for DAILY, ISO-week for WEEKLY, calendar month
 *      for MONTHLY.
 *
 *   5. `bankedVsAtRisk` — given the total deposited + total withdrawn + current
 *      balance, return `{ banked: totalWithdrawn - totalDeposited,
 *      atRisk: currentBalance }`. Banked is what the trader has moved OUT of
 *      the broker account (net of deposits). At risk is what's still in.
 *
 *   6. `isBigWinDay` — given today's P/L, the balance, and a threshold percent,
 *      return true iff |todayPL| / max(balance, 1) × 100 >= threshold.
 *
 * All functions are DB-free and deterministic for the same inputs.
 */
import Decimal from "decimal.js";

export type WithdrawalRuleType = "PERCENT_OF_PROFIT" | "FIXED_AMOUNT" | "BALANCE_ABOVE_THRESHOLD";

export type WithdrawalFrequency = "DAILY" | "WEEKLY" | "MONTHLY";

export type WithdrawalBaseline = "STARTING_BALANCE" | "LAST_WITHDRAWAL" | "HIGH_WATER_MARK";

// ─── 1. computeProfitSinceBaseline ────────────────────────────────────────────

export type ProfitInput = {
  startingBalance: Decimal | string | number;
  currentBalance: Decimal | string | number;
  /** Balance right after the most recent WITHDRAWAL transaction. null when
   * the rule's baseline is LAST_WITHDRAWAL but no withdrawal has happened
   * yet — we fall back to startingBalance in that case (the profit since
   * the start, which is the conservative interpretation). */
  lastWithdrawalBalance?: Decimal | string | number | null;
  /** Peak balance ever reached. null when the rule's baseline is
   * HIGH_WATER_MARK but no mark has been tracked yet — we fall back to
   * startingBalance. */
  highWaterMark?: Decimal | string | number | null;
  baseline: WithdrawalBaseline;
};

/**
 * Compute the profit available for withdrawal under the rule's baseline.
 *
 * Examples (current=1200, starting=1000, lastWd=1100, hwm=1300):
 *   STARTING_BALANCE  → 1200 − 1000 = +200
 *   LAST_WITHDRAWAL   → 1200 − 1100 = +100
 *   HIGH_WATER_MARK   → 1200 − 1300 = -100 (in drawdown; no withdrawal due)
 *
 * Edge cases:
 *   - LAST_WITHDRAWAL with no prior withdrawal → falls back to startingBalance
 *   - HIGH_WATER_MARK with null mark → falls back to startingBalance
 *   - currentBalance < baseline → returns a negative Decimal (drawdown)
 */
export function computeProfitSinceBaseline(input: ProfitInput): Decimal {
  const current = new Decimal(input.currentBalance.toString());
  const starting = new Decimal(input.startingBalance.toString());
  let anchor: Decimal;
  switch (input.baseline) {
    case "STARTING_BALANCE":
      anchor = starting;
      break;
    case "LAST_WITHDRAWAL": {
      const lw = input.lastWithdrawalBalance;
      anchor = lw == null ? starting : new Decimal(lw.toString());
      break;
    }
    case "HIGH_WATER_MARK": {
      const hwm = input.highWaterMark;
      anchor = hwm == null ? starting : new Decimal(hwm.toString());
      break;
    }
    default: {
      // Exhaustive guard — TypeScript should reject unknown baselines at
      // compile time, but be defensive anyway.
      const _exhaustive: never = input.baseline;
      anchor = starting;
      void _exhaustive;
    }
  }
  return current.minus(anchor);
}

// ─── 2. recommendWithdrawalAmount ─────────────────────────────────────────────

export type RecommendationInput = {
  type: WithdrawalRuleType;
  /** Percent (0–100) for PERCENT_OF_PROFIT; flat amount for FIXED_AMOUNT;
   * threshold balance for BALANCE_ABOVE_THRESHOLD. */
  value: Decimal | string | number;
  /** Signed profit since baseline. Negative ⇒ no withdrawal recommended. */
  profitSinceBaseline: Decimal | string | number;
  /** Current account balance (needed for the threshold-type rule). */
  currentBalance: Decimal | string | number;
};

/**
 * Compute the recommended withdrawal amount. The result is always a
 * non-negative Decimal (≥ 0) — when the rule wouldn't fire (no profit,
 * balance below threshold), returns 0.
 *
 * Examples:
 *   PERCENT_OF_PROFIT, value=20, profit=200  → 0.20 × 200 = 40
 *   PERCENT_OF_PROFIT, value=20, profit=-50  → 0 (no profit; don't withdraw)
 *   FIXED_AMOUNT, value=50, profit=200       → 50 (independent of profit,
 *                                              but only if profit > 0 —
 *                                              see the edge-case handling
 *                                              below)
 *   FIXED_AMOUNT, value=50, profit=0         → 0 (no profit; don't withdraw)
 *   BALANCE_ABOVE_THRESHOLD, value=1000,
 *     current=1200                           → 1200 − 1000 = 200
 *   BALANCE_ABOVE_THRESHOLD, value=1000,
 *     current=950                            → 0 (balance below threshold)
 *
 * Edge case: a FIXED_AMOUNT rule with a value larger than the actual profit
 * still recommends the full amount (the trader may want to bank a fixed sum
 * regardless of profit), but only if the profit is strictly positive — this
 * prevents withdrawals when the account is in drawdown vs the baseline.
 */
export function recommendWithdrawalAmount(input: RecommendationInput): Decimal {
  const profit = new Decimal(input.profitSinceBaseline.toString());
  // Never recommend a withdrawal when the account is in drawdown vs baseline.
  if (profit.lte(0)) return new Decimal(0);

  const value = new Decimal(input.value.toString());
  const current = new Decimal(input.currentBalance.toString());

  switch (input.type) {
    case "PERCENT_OF_PROFIT": {
      // value is a percent (0–100); convert to fraction.
      const fraction = value.div(100);
      return fraction.times(profit).toDecimalPlaces(2);
    }
    case "FIXED_AMOUNT": {
      // Recommend the flat amount, but never more than the available profit
      // (we don't want to withdraw the trader's principal — only profit).
      return Decimal.min(value, profit).toDecimalPlaces(2);
    }
    case "BALANCE_ABOVE_THRESHOLD": {
      // Recommend everything above the threshold balance.
      if (current.lte(value)) return new Decimal(0);
      return current.minus(value).toDecimalPlaces(2);
    }
    default: {
      const _exhaustive: never = input.type;
      void _exhaustive;
      return new Decimal(0);
    }
  }
}

// ─── 3. trackHighWaterMark ────────────────────────────────────────────────────

/**
 * Return the new high-water mark = max(currentMark, currentBalance). When
 * `currentMark` is null (never tracked), the new mark is the currentBalance
 * itself — the first call seeds the mark.
 *
 * Pure: caller persists the returned value on the TradingAccount row.
 */
export function trackHighWaterMark(
  currentMark: Decimal | string | number | null,
  currentBalance: Decimal | string | number,
): Decimal {
  const balance = new Decimal(currentBalance.toString());
  if (currentMark == null) return balance;
  const mark = new Decimal(currentMark.toString());
  return Decimal.max(mark, balance);
}

// ─── 4. isWithdrawalDue ───────────────────────────────────────────────────────

export type DueInput = {
  frequency: WithdrawalFrequency;
  lastTriggeredAt: Date | null;
  now: Date;
};

/**
 * Decide whether a withdrawal rule is "due" to fire a reminder based on its
 * frequency and lastTriggeredAt. Uses day-of-week (DAILY), ISO-week (WEEKLY),
 * and calendar month (MONTHLY) comparison in UTC — the user's TZ is applied
 * by the caller when computing `now`, so this function stays pure.
 *
 * Examples:
 *   DAILY + lastTriggeredAt=null                       → true (never fired)
 *   DAILY + lastTriggeredAt=earlier today              → false (same day)
 *   DAILY + lastTriggeredAt=yesterday                  → true
 *   WEEKLY + lastTriggeredAt=earlier this week         → false
 *   WEEKLY + lastTriggeredAt=last week                 → true
 *   MONTHLY + lastTriggeredAt=earlier this month       → false
 *   MONTHLY + lastTriggeredAt=last month               → true
 */
export function isWithdrawalDue(input: DueInput): boolean {
  const now = input.now;
  const last = input.lastTriggeredAt;
  if (last == null) return true;

  switch (input.frequency) {
    case "DAILY":
      return !sameDay(last, now);
    case "WEEKLY":
      return !sameIsoWeek(last, now);
    case "MONTHLY":
      return !sameCalendarMonth(last, now);
    default: {
      const _exhaustive: never = input.frequency;
      void _exhaustive;
      return true;
    }
  }
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function sameCalendarMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

function sameIsoWeek(a: Date, b: Date): boolean {
  return isoWeekKey(a) === isoWeekKey(b);
}

function isoWeekKey(d: Date): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3); // Thursday anchor
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round((tmp.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ─── 5. bankedVsAtRisk ────────────────────────────────────────────────────────

export type BankedInput = {
  totalDeposited: Decimal | string | number;
  totalWithdrawn: Decimal | string | number;
  currentBalance: Decimal | string | number;
};

export type BankedResult = {
  /** Banked = totalWithdrawn − totalDeposited. Positive = trader has moved
   * more money OUT of the broker account than they put in (net profit banked).
   * Negative = trader is net-down on principal (still in the broker account). */
  banked: Decimal;
  /** At risk = currentBalance. The money still in the broker account that
   * could be lost on the next trade. */
  atRisk: Decimal;
};

/**
 * Compute the "banked profit vs at-risk" pair. Banked is the net amount
 * the trader has moved OUT of the broker (withdrawals minus deposits); at
 * risk is what's still sitting in the account.
 *
 * The banked number is the only money that's truly safe — everything in the
 * broker account is at risk on the next trade. This is the core
 * "discipline metric" Phase 19 surfaces on the dashboard.
 *
 * Examples:
 *   deposits=1000, withdrawals=300, current=850  → banked=-700, atRisk=850
 *     (still net-down on principal — the trader withdrew 300 but deposited 1000,
 *      so 700 of principal is still in the account)
 *   deposits=1000, withdrawals=1300, current=850 → banked=+300, atRisk=850
 *     (the trader has banked 300 of net profit on top of recovering all principal)
 */
export function bankedVsAtRisk(input: BankedInput): BankedResult {
  const deposited = new Decimal(input.totalDeposited.toString());
  const withdrawn = new Decimal(input.totalWithdrawn.toString());
  const current = new Decimal(input.currentBalance.toString());
  return {
    banked: withdrawn.minus(deposited),
    atRisk: current,
  };
}

// ─── 6. isBigWinDay ───────────────────────────────────────────────────────────

export type BigWinDayInput = {
  /** Today's signed P/L. Negative or zero ⇒ not a big-win day. */
  todayPL: Decimal | string | number;
  /** Account balance at the start of today (or current balance — caller's
   * choice; the spec says "configurable %" of the balance). */
  balance: Decimal | string | number;
  /** Threshold percent (0–1000). E.g. 20 means todayPL must be ≥ 20% of
   * balance. null disables the check (returns false). */
  thresholdPercent: Decimal | string | number | null;
};

/**
 * Return true iff today's P/L is at least `thresholdPercent`% of the balance.
 * Uses `max(|balance|, 1)` as the denominator to avoid divide-by-zero.
 *
 * Examples:
 *   todayPL=200, balance=1000, threshold=20  → 200/1000 × 100 = 20 ≥ 20 → true
 *   todayPL=150, balance=1000, threshold=20  → 15% < 20 → false
 *   todayPL=-300, balance=1000, threshold=20 → negative PL → false (big LOSS day, not big WIN day)
 *   todayPL=200, balance=0, threshold=20     → denom=1, 200/1×100 = 20000 → true (huge win on tiny base)
 *   threshold=null                            → false (disabled)
 */
export function isBigWinDay(input: BigWinDayInput): boolean {
  if (input.thresholdPercent == null) return false;
  const pl = new Decimal(input.todayPL.toString());
  if (pl.lte(0)) return false; // Only a *win* day counts.
  const balance = new Decimal(input.balance.toString());
  const denom = Decimal.max(balance.abs(), new Decimal(1));
  const pct = pl.div(denom).times(100);
  const threshold = new Decimal(input.thresholdPercent.toString());
  return pct.gte(threshold);
}
