/**
 * Pure discipline-score calc helpers for Phase 21 — Discipline Score &
 * Streaks.
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib/calc` or
 * `/src/lib/behavior` as pure, unit-tested functions. rule #1: money is
 * Decimal — never Float, though discipline scores are plain JS `number`
 * since they're 0-100 integers, not money.)
 *
 * The discipline score is 0–100 with weights from DISCIPLINE_WEIGHTS:
 *
 *   30 — RISK_PER_TRADE: stayed within risk-per-trade limit on every trade
 *   25 — NO_DAILY_BREACH: no daily loss or trade-count breach
 *   15 — NO_OVERRIDES: no overrides of lockouts or warnings
 *   15 — FOLLOWED_PLAN: followedPlan true on all trades
 *   10 — NO_TILT: no TILT events
 *    5 — CHECKLIST_AND_BALANCE: pre-trade checklist completed and balance check done
 *
 * Total = 100. Each rule is binary (earn all-or-nothing) — the spec says
 * "stayed within... on every trade" / "no overrides" / "followedPlan true
 * on all trades" / "no TILT events" — all binary conditions.
 *
 * Rest days: a day with 0 trades AND 0 breaches of any kind counts as a
 * "rest day" (neutral). It keeps the streak continuing without
 * incrementing it. The score for a rest day is still computed (it'll be
 * 30+25+15+15+10+0=95 because all rules are vacuously true except
 * checklist-and-balance) but the streak logic uses `isRestDay` rather than
 * the score threshold to keep things neutral.
 *
 * Exports:
 *   - DISCIPLINE_WEIGHTS: configurable weight constants (total = 100).
 *   - dailyDisciplineScore(day): the per-day computation.
 *   - disciplinedDayStreak(scores, todayKey): current streak walking
 *     backwards from today, with rest-day handling.
 *   - bestStreak(scores): the longest run of (disciplined OR rest) days.
 *   - isDisciplinedDay(score, isRestDay): score >= 80 OR rest day.
 *   - averageScore(scores): plain mean of scores (rest days included).
 */

import Decimal from "decimal.js";

// ─── Configurable weights (total = 100) ─────────────────────────────────────

/**
 * The weight of each rule in the composite discipline score. These are
 * exported as constants so the weights can be tuned without touching the
 * computation logic. The sum must equal 100 — `dailyDisciplineScore` asserts
 * this at module load via the type system (the literal `100`).
 *
 * Tuning rationale:
 *   - RISK_PER_TRADE (30): the heaviest weight — staying within the
 *     risk-per-trade limit is the single most important discipline signal.
 *   - NO_DAILY_BREACH (25): the daily loss / trade-count guardrail is the
 *     second-most important — it prevents tilt-spending after a bad day.
 *   - NO_OVERRIDES (15): overriding a lockout is a discipline failure
 *     (you bypassed your own rules), but it's rarer so the weight is lower.
 *   - FOLLOWED_PLAN (15): trading off-plan is a discipline failure, weighted
 *     equal to overrides.
 *   - NO_TILT (10): tilt events are signals of emotional trading — present
 *     even when no rule is formally breached.
 *   - CHECKLIST_AND_BALANCE (5): the smallest weight, but non-zero — the
 *     pre-trade checklist + balance check are routine discipline habits.
 */
export const DISCIPLINE_WEIGHTS = {
  RISK_PER_TRADE: 30,
  NO_DAILY_BREACH: 25,
  NO_OVERRIDES: 15,
  FOLLOWED_PLAN: 15,
  NO_TILT: 10,
  CHECKLIST_AND_BALANCE: 5,
} as const;

export type DisciplineRuleKey = keyof typeof DISCIPLINE_WEIGHTS;

// Compile-time + runtime assertion that the weights sum to 100. If a
// developer changes a weight without keeping the total at 100, the runtime
// check throws at module load (and the TS literal-100 assertion catches
// type drift in IDEs that support it).
const _WEIGHT_TOTAL =
  DISCIPLINE_WEIGHTS.RISK_PER_TRADE +
  DISCIPLINE_WEIGHTS.NO_DAILY_BREACH +
  DISCIPLINE_WEIGHTS.NO_OVERRIDES +
  DISCIPLINE_WEIGHTS.FOLLOWED_PLAN +
  DISCIPLINE_WEIGHTS.NO_TILT +
  DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE;
if (_WEIGHT_TOTAL !== 100) {
  throw new Error(
    `DISCIPLINE_WEIGHTS must sum to 100; got ${_WEIGHT_TOTAL}. Update the constants so the composite score stays on a 0-100 scale.`,
  );
}

// ─── Per-day input + output types ───────────────────────────────────────────

export type DisciplineTradeInput = {
  id: string;
  /** Stake in account currency. */
  stake: Decimal | string | number;
  /** Whether the trader marked "This trade follows my plan". */
  followedPlan: boolean;
  /** True iff the stake exceeded the risk-per-trade limit for that account
   *  (rule #1: risk-per-trade). The caller (server action) computes this by
   *  comparing stake to `riskPerTradePercent * currentBalance` — kept as a
   *  pre-computed boolean here to keep the pure calc DB-free. */
  breachedRiskPerTrade?: boolean;
};

export type DisciplineDayInput = {
  /** The day's closed trades (WIN/LOSS/TIE — OPEN excluded since they
   *  don't count for the day's P/L). */
  trades: DisciplineTradeInput[];
  /** True iff any trade exceeded the risk-per-trade limit. The action
   *  computes this per trade (stake > riskPerTradePercent * balance) and
   *  passes the OR of all trades. */
  riskPerTradeBreachedOnAnyTrade?: boolean;
  /** True iff the day's loss exceeded the max-daily-loss limit (percent
   *  or flat cap, whichever is set). */
  dailyLossBreached?: boolean;
  /** True iff the day's trade count exceeded maxTradesPerDay. */
  tradeCountBreached?: boolean;
  /** Number of lockout overrides recorded that day. */
  lockoutOverrides: number;
  /** Number of pre-trade warning overrides recorded that day (the WARN
   *  severity that the trader proceeded past in Phase 17's confirmation
   *  dialog). */
  warningOverrides: number;
  /** Number of TiltEvent rows (level=TILT, not just CAUTION) recorded
   *  that day. */
  tiltEvents: number;
  /** True iff the user completed the pre-trade checklist that day
   *  (Phase 10's TradingSession checklist OR a manual check). */
  checklistCompleted: boolean;
  /** True iff the user did at least one broker balance check that day
   *  (Phase 18 BalanceCheck row exists). */
  balanceCheckDone: boolean;
};

export type DisciplineRuleBreakdown = {
  rule: DisciplineRuleKey;
  earned: number; // 0 or weight
  total: number; // weight
  lost: number; // total - earned
  reason: string;
  tradeIds?: string[]; // trades responsible when points were lost
};

export type DisciplineScoreResult = {
  /** 0–100, clamped. */
  score: number;
  /** Per-rule breakdown for the UI drawer. */
  breakdown: DisciplineRuleBreakdown[];
  /** True iff 0 trades AND 0 breaches of any kind (rest day). */
  isRestDay: boolean;
};

// ─── dailyDisciplineScore ───────────────────────────────────────────────────

/**
 * Compute the discipline score for a single day.
 *
 * Each rule is binary (earn all-or-nothing):
 *   - RISK_PER_TRADE: earn 30 iff `riskPerTradeBreachedOnAnyTrade` is false
 *     (or undefined, treated as no breach). When breached, lose all 30 +
 *     include the IDs of trades that breached (caller should pre-mark
 *     `breachedRiskPerTrade: true` on each responsible trade).
 *   - NO_DAILY_BREACH: earn 25 iff neither `dailyLossBreached` nor
 *     `tradeCountBreached` is true.
 *   - NO_OVERRIDES: earn 15 iff `lockoutOverrides === 0 && warningOverrides === 0`.
 *   - FOLLOWED_PLAN: earn 15 iff every trade has `followedPlan: true`.
 *   - NO_TILT: earn 10 iff `tiltEvents === 0`.
 *   - CHECKLIST_AND_BALANCE: earn 5 iff both `checklistCompleted` and
 *     `balanceCheckDone` are true.
 *
 * `isRestDay` = true iff `trades.length === 0` AND no breaches of any kind
 * AND `lockoutOverrides === 0` AND `warningOverrides === 0` AND
 * `tiltEvents === 0`. Rest days keep their score (typically 95 — only
 * CHECKLIST_AND_BALANCE is lost because the trader didn't trade) but the
 * streak logic uses `isRestDay` to keep the streak continuing without
 * incrementing.
 *
 * Edge case: if `trades.length === 0` AND there's a breach (override, tilt),
 * the day is NOT a rest day. The score will reflect the deductions.
 */
export function dailyDisciplineScore(day: DisciplineDayInput): DisciplineScoreResult {
  const breakdown: DisciplineRuleBreakdown[] = [];

  // 1. RISK_PER_TRADE (30 pts)
  const riskBreachedTrades = day.trades.filter((t) => t.breachedRiskPerTrade === true);
  const anyRiskBreach =
    day.riskPerTradeBreachedOnAnyTrade === true || riskBreachedTrades.length > 0;
  breakdown.push({
    rule: "RISK_PER_TRADE",
    earned: anyRiskBreach ? 0 : DISCIPLINE_WEIGHTS.RISK_PER_TRADE,
    total: DISCIPLINE_WEIGHTS.RISK_PER_TRADE,
    lost: anyRiskBreach ? DISCIPLINE_WEIGHTS.RISK_PER_TRADE : 0,
    reason: anyRiskBreach
      ? `${riskBreachedTrades.length} trade${riskBreachedTrades.length === 1 ? "" : "s"} exceeded the risk-per-trade limit.`
      : "All trades stayed within the risk-per-trade limit.",
    tradeIds: anyRiskBreach ? riskBreachedTrades.map((t) => t.id) : undefined,
  });

  // 2. NO_DAILY_BREACH (25 pts)
  const dailyLossBreached = day.dailyLossBreached === true;
  const tradeCountBreached = day.tradeCountBreached === true;
  const anyDailyBreach = dailyLossBreached || tradeCountBreached;
  const breachDetails: string[] = [];
  if (dailyLossBreached) breachDetails.push("daily loss limit");
  if (tradeCountBreached) breachDetails.push("max trades per day");
  breakdown.push({
    rule: "NO_DAILY_BREACH",
    earned: anyDailyBreach ? 0 : DISCIPLINE_WEIGHTS.NO_DAILY_BREACH,
    total: DISCIPLINE_WEIGHTS.NO_DAILY_BREACH,
    lost: anyDailyBreach ? DISCIPLINE_WEIGHTS.NO_DAILY_BREACH : 0,
    reason: anyDailyBreach
      ? `Breached: ${breachDetails.join(" + ")}.`
      : "No daily loss or trade-count breach.",
  });

  // 3. NO_OVERRIDES (15 pts)
  const anyOverride = day.lockoutOverrides > 0 || day.warningOverrides > 0;
  breakdown.push({
    rule: "NO_OVERRIDES",
    earned: anyOverride ? 0 : DISCIPLINE_WEIGHTS.NO_OVERRIDES,
    total: DISCIPLINE_WEIGHTS.NO_OVERRIDES,
    lost: anyOverride ? DISCIPLINE_WEIGHTS.NO_OVERRIDES : 0,
    reason: anyOverride
      ? `${day.lockoutOverrides} lockout override${day.lockoutOverrides === 1 ? "" : "s"}, ${day.warningOverrides} warning override${day.warningOverrides === 1 ? "" : "s"}.`
      : "No overrides of lockouts or warnings.",
  });

  // 4. FOLLOWED_PLAN (15 pts)
  const brokePlanTrades = day.trades.filter((t) => !t.followedPlan);
  const anyBrokePlan = brokePlanTrades.length > 0;
  breakdown.push({
    rule: "FOLLOWED_PLAN",
    earned: anyBrokePlan ? 0 : DISCIPLINE_WEIGHTS.FOLLOWED_PLAN,
    total: DISCIPLINE_WEIGHTS.FOLLOWED_PLAN,
    lost: anyBrokePlan ? DISCIPLINE_WEIGHTS.FOLLOWED_PLAN : 0,
    reason: anyBrokePlan
      ? `${brokePlanTrades.length} trade${brokePlanTrades.length === 1 ? "" : "s"} marked as not following the plan.`
      : "followedPlan was true on all trades.",
    tradeIds: anyBrokePlan ? brokePlanTrades.map((t) => t.id) : undefined,
  });

  // 5. NO_TILT (10 pts)
  const anyTilt = day.tiltEvents > 0;
  breakdown.push({
    rule: "NO_TILT",
    earned: anyTilt ? 0 : DISCIPLINE_WEIGHTS.NO_TILT,
    total: DISCIPLINE_WEIGHTS.NO_TILT,
    lost: anyTilt ? DISCIPLINE_WEIGHTS.NO_TILT : 0,
    reason: anyTilt
      ? `${day.tiltEvents} TILT event${day.tiltEvents === 1 ? "" : "s"} recorded.`
      : "No TILT events.",
  });

  // 6. CHECKLIST_AND_BALANCE (5 pts)
  const checklistDone = day.checklistCompleted === true;
  const balanceDone = day.balanceCheckDone === true;
  const bothDone = checklistDone && balanceDone;
  breakdown.push({
    rule: "CHECKLIST_AND_BALANCE",
    earned: bothDone ? DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE : 0,
    total: DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE,
    lost: bothDone ? 0 : DISCIPLINE_WEIGHTS.CHECKLIST_AND_BALANCE,
    reason: bothDone
      ? "Pre-trade checklist completed and balance check done."
      : !checklistDone && !balanceDone
        ? "Neither the pre-trade checklist nor a balance check was done."
        : !checklistDone
          ? "Pre-trade checklist not completed."
          : "No broker balance check done today.",
  });

  // Total = sum of earned (already clamped to weight per rule).
  const rawScore = breakdown.reduce((acc, b) => acc + b.earned, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  // Rest day: 0 trades AND no breaches of any kind (no risk breach, no
  // daily breach, no overrides, no tilt). The checklist/balance flag
  // doesn't disqualify a rest day — those are routine-habit points, not
  // breach indicators.
  const isRestDay =
    day.trades.length === 0 && !anyRiskBreach && !anyDailyBreach && !anyOverride && !anyTilt;

  return { score, breakdown, isRestDay };
}

// ─── Streak logic ─────────────────────────────────────────────────────────────

export type DailyScoreEntry = {
  /** "YYYY-MM-DD" — must be in the user's TZ for streak math to work. */
  date: string;
  /** 0–100 discipline score. */
  score: number;
  /** True iff the day was a rest day (no trades + no breaches). */
  isRestDay: boolean;
};

/**
 * A "disciplined day" is a day with score >= 80 OR a rest day. Rest days are
 * neutral — they keep the streak but don't increment it. Days below 80 that
 * aren't rest days break the streak.
 */
export function isDisciplinedDay(score: number, isRestDay: boolean): boolean {
  return isRestDay || score >= 80;
}

/**
 * Walk backwards from `todayKey` (YYYY-MM-DD in the user's TZ) through the
 * `scores` array (which must be sorted ascending by date). For each day:
 *   - If the day has a DailyScoreEntry:
 *     - If `isRestDay` → continue (no increment, no break)
 *     - Else if `score >= 80` → streak++
 *     - Else → break
 *   - If the day has no entry (gap): we treat it as a rest day (no trades
 *     and no breaches — the user simply didn't trade). Continue. This is
 *     important for users who don't trade on weekends or holidays.
 * The walk stops at the first non-disciplined day (or when we run out of
 * historical entries).
 *
 * Timezone boundaries: the caller is responsible for converting each
 * DailyScore row's `date` to the user's TZ day key. The streak logic uses
 * the dayKey string comparison + 1-day increments — no Date math, so no
 * TZ drift.
 *
 * @param scores Sorted-ascending array of DailyScoreEntry
 * @param todayKey "YYYY-MM-DD" in the user's TZ
 * @param lookbackDays Max days to walk back (default 365 — generous cap to
 *   bound the loop)
 */
export function disciplinedDayStreak(
  scores: DailyScoreEntry[],
  todayKey: string,
  lookbackDays: number = 365,
): number {
  // Index scores by date for O(1) lookup.
  const byDate = new Map(scores.map((s) => [s.date, s]));
  // Find the earliest entry so we can stop early when we walk past all
  // historical data. Computed defensively (the input may be unsorted).
  const minDate =
    scores.length === 0
      ? todayKey
      : scores.reduce((min, s) => (s.date < min ? s.date : min), scores[0].date);
  let streak = 0;
  // Walk backwards from today.
  let cursor = todayKey;
  for (let i = 0; i < lookbackDays; i++) {
    const entry = byDate.get(cursor);
    if (entry) {
      if (entry.isRestDay) {
        // Continue — rest day keeps the streak without incrementing.
      } else if (entry.score >= 80) {
        streak++;
      } else {
        break;
      }
    } else {
      // No entry for this day — treat as a rest day (no trades + no
      // breaches). Continue without incrementing.
    }
    const nextCursor = shiftDayKey(cursor, -1);
    if (nextCursor < minDate) break;
    cursor = nextCursor;
  }
  return streak;
}

/**
 * Compute the best (longest) disciplined-day streak across the `scores`
 * array. A "disciplined day" is rest OR score >= 80. The streak breaks on
 * any non-disciplined day. Walks the array forward (oldest first) counting
 * consecutive disciplined runs.
 */
export function bestStreak(scores: DailyScoreEntry[]): number {
  let best = 0;
  let current = 0;
  // The scores array must be sorted ascending by date for this to be
  // correct. We tolerate unsorted input by sorting defensively.
  const sorted = [...scores].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sorted) {
    if (isDisciplinedDay(s.score, s.isRestDay)) {
      // Disciplined days (score >= 80 AND not rest) increment; rest days
      // keep the streak continuing without incrementing. This matches
      // `disciplinedDayStreak`'s behavior.
      if (!s.isRestDay && s.score >= 80) current++;
      // else: rest day — continue without incrementing
    } else {
      if (current > best) best = current;
      current = 0;
    }
  }
  if (current > best) best = current;
  return best;
}

/**
 * Plain mean of scores (rest days included, treated at their actual score
 * which is typically 95 — only the CHECKLIST_AND_BALANCE 5 points are
 * lost on a rest day). Returns null when the array is empty.
 *
 * @param scores Array of DailyScoreEntry
 * @returns number (0-100) or null
 */
export function averageScore(scores: DailyScoreEntry[]): number | null {
  if (scores.length === 0) return null;
  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  return Math.round((sum / scores.length) * 10) / 10; // 1 decimal
}

// ─── Day-key arithmetic (TZ-safe) ─────────────────────────────────────────────

/**
 * Shift a "YYYY-MM-DD" string by `deltaDays`. Uses UTC arithmetic on a
 * constructed Date — the caller passes day keys that already represent
 * the user's TZ day, so the arithmetic is just calendar-day math with no
 * TZ drift.
 *
 * Examples:
 *   shiftDayKey("2025-06-15", -1) → "2025-06-14"
 *   shiftDayKey("2025-06-01", -1) → "2025-05-31" (month boundary)
 *   shiftDayKey("2025-03-01", -1) → "2025-02-28" (leap-year-aware)
 */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  // Validate the YYYY-MM-DD format defensively.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    throw new Error(`shiftDayKey: invalid day key "${dayKey}"; expected YYYY-MM-DD`);
  }
  const [y, m, d] = match.slice(1, 4).map(Number);
  // Construct a UTC Date — day-key math is calendar-day-only, no TZ.
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  // Format back to YYYY-MM-DD.
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compute the "YYYY-MM-DD" day key for a Date in the given IANA timezone.
 * Uses `Intl.DateTimeFormat("en-CA", ...)` which formats as YYYY-MM-DD
 * (the "en-CA" locale's default). Falls back to UTC slice if the tz is
 * invalid.
 */
export function dayKeyInTz(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
