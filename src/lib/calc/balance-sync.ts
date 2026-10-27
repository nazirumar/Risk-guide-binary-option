/**
 * Pure calc helpers for Phase 18 — Broker Balance Sync Checks.
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib/calc` as pure,
 * unit-tested functions. rule #1: money is Decimal — never Float.)
 *
 * Three exported pure functions:
 *
 *   1. `computeCheckResult` — given the app's computed balance, the
 *      user-entered broker balance, and a tolerance percent, return the
 *      signed difference, the percentage difference, and whether the two
 *      balances agree within tolerance.
 *
 *   2. `scoreAccuracy` — given a list of BalanceCheck rows and a "since"
 *      cutoff, return the share of rows that resolved to MATCHED (0–100).
 *      Returns null when there are no checks in the window (so the UI can
 *      say "no data yet" instead of misleading with 0%).
 *
 *   3. `suggestCauses` — given the difference + recent trades + recent
 *      transactions + a list of recently-used stake amounts, produce a
 *      ranked list of plausible-cause suggestions. Heuristics only — this
 *      is a discipline aid, not forensic accounting.
 *
 * All functions are DB-free and deterministic for the same inputs.
 */
import Decimal from "decimal.js";

export type BalanceCheckLike = {
  /**
   * null = pending (mismatch detected, user hasn't yet picked Adjust/Ignore).
   * MATCHED = within tolerance at check time (terminal). ADJUSTED = mismatch
   * resolved by creating an ADJUSTMENT transaction (terminal). IGNORED =
   * mismatch dismissed with a note (terminal).
   *
   * The accuracy score counts ONLY MATCHED rows as accurate; null/ADJUSTED/
   * IGNORED all count toward the denominator (the score measures how often
   * reality matched our books at check time).
   */
  resolution: "MATCHED" | "ADJUSTED" | "IGNORED" | null;
  checkedAt: Date;
};

export type CheckResult = {
  /** brokerBalance - appBalance, signed. Positive = broker shows more. */
  difference: Decimal;
  /** |difference| / max(|appBalance|, 1) * 100, never negative. */
  percentDiff: Decimal;
  /** True iff percentDiff <= tolerancePercent. Also true when difference is 0. */
  isMatched: boolean;
};

export type CauseSuggestion = {
  kind: "WRONG_PAYOUT" | "MISSING_DEPOSIT" | "MISSING_WITHDRAWAL" | "MATCHES_STAKE" | "GAP_DAY";
  title: string;
  detail: string;
};

export type CauseInputTrade = {
  profitLoss: Decimal | string | number;
  stake?: Decimal | string | number;
  payoutPercent?: Decimal | string | number;
  openedAt?: Date;
  closedAt?: Date;
  result?: string;
};

export type CauseInputTransaction = {
  type: "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT" | string;
  amount: Decimal | string | number;
  occurredAt?: Date;
};

export type CauseInput = {
  difference: Decimal | string | number;
  trades: CauseInputTrade[];
  transactions: CauseInputTransaction[];
  commonStakes?: (Decimal | string | number)[];
  now?: Date;
  /** default 7 — used by MISSING_DEPOSIT/MISSING_WITHDRAWAL/GAP_DAY windows */
  lookbackDays?: number;
};

// ─── 1. computeCheckResult ──────────────────────────────────────────────────

/**
 * Compute the signed difference + percentage difference + MATCHED flag for a
 * balance check. The tolerance is a percent (0.5 = 0.5%); the denominator is
 * `max(|appBalance|, 1)` so the formula never divides by zero.
 *
 * Examples (tolerance = 0.5):
 *   app=1000, broker=1000  → diff=0,     pct=0,     matched=true
 *   app=1000, broker=1005  → diff=+5,    pct=0.5,   matched=true   (pct == tol)
 *   app=1000, broker=1006  → diff=+6,    pct=0.6,   matched=false  (pct > tol)
 *   app=1000, broker=990   → diff=-10,   pct=1.0,   matched=false
 *   app=0,    broker=0     → diff=0,     pct=0,     matched=true
 *   app=0,    broker=10    → diff=+10,   pct=1000,  matched=false  (denom=1)
 */
export function computeCheckResult(input: {
  appBalance: Decimal | string | number;
  brokerBalance: Decimal | string | number;
  tolerancePercent: Decimal | string | number;
}): CheckResult {
  const app = new Decimal(input.appBalance.toString());
  const broker = new Decimal(input.brokerBalance.toString());
  const tolerance = new Decimal(input.tolerancePercent.toString());

  const difference = broker.minus(app);
  const absDiff = difference.abs();
  const denom = Decimal.max(app.abs(), new Decimal(1));
  // percentDiff = |difference| / denom × 100, rounded to 4 dp for stability.
  const percentDiff = absDiff.div(denom).times(100).toDecimalPlaces(4);
  const isMatched = percentDiff.lte(tolerance) || absDiff.isZero();

  return { difference, percentDiff, isMatched };
}

// ─── 2. scoreAccuracy ────────────────────────────────────────────────────────

/**
 * Percentage of BalanceCheck rows in the trailing window whose resolution is
 * MATCHED. Returns null when no rows fall in the window — the UI then says
 * "no data yet" rather than misleading with 0%.
 *
 * The window is `checkedAt >= since` (caller passes `now - 30 days`).
 */
export function scoreAccuracy(checks: BalanceCheckLike[], since: Date): number | null {
  const inWindow = checks.filter((c) => c.checkedAt >= since);
  if (inWindow.length === 0) return null;
  const matched = inWindow.filter((c) => c.resolution === "MATCHED").length;
  // Decimal-safe percentage (avoid Float division); round down to integer %.
  return new Decimal(matched)
    .times(100)
    .div(inWindow.length)
    .toDecimalPlaces(0, Decimal.ROUND_DOWN)
    .toNumber();
}

// ─── 3. suggestCauses ───────────────────────────────────────────────────────

/**
 * Suggest plausible reasons for a non-zero difference. Heuristics:
 *
 *   - WRONG_PAYOUT      — a closed trade whose |profitLoss| is within ±2% of
 *                         |difference| (its payout may have been mis-entered).
 *   - MISSING_DEPOSIT   — broker shows MORE (diff > 0) and no DEPOSIT in the
 *                         lookback window → "did you add funds without
 *                         recording it?"
 *   - MISSING_WITHDRAWAL— broker shows LESS (diff < 0) and no WITHDRAWAL in
 *                         the lookback window.
 *   - MATCHES_STAKE     — |difference| is within ±2 of a recently-used stake
 *                         → "could be a missed trade outcome at this stake".
 *   - GAP_DAY           — a day in the lookback window has zero transactions
 *                         AND zero trades → "did you trade on {date} but
 *                         forget to record it?"
 *
 * The function never throws — bad inputs yield an empty suggestion list.
 */
export function suggestCauses(input: CauseInput): CauseSuggestion[] {
  const difference = new Decimal(input.difference.toString());
  // Zero difference → no causes needed (caller usually won't even ask).
  if (difference.isZero()) return [];

  const now = input.now ?? new Date();
  const lookbackDays = input.lookbackDays ?? 7;
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const absDiff = difference.abs();
  // ±2% tolerance for "close to difference" comparisons (payout / stake match).
  const twoPercent = absDiff.times(0.02);
  // Absolute $-tolerance for "close to a stake amount" (±$2 in any currency).
  const stakeAbsTol = new Decimal(2);

  const out: CauseSuggestion[] = [];

  // ── WRONG_PAYOUT ──
  for (const t of input.trades) {
    if (t.result && t.result !== "WIN" && t.result !== "LOSS" && t.result !== "TIE") {
      continue;
    }
    const pl = new Decimal(t.profitLoss.toString());
    const distance = pl.abs().minus(absDiff).abs();
    if (distance.lte(twoPercent) || distance.lte(stakeAbsTol)) {
      out.push({
        kind: "WRONG_PAYOUT",
        title: "Check a trade's payout",
        detail: `A trade's profit/loss of ${pl.toFixed(2)} is close to the difference of ${difference.abs().toFixed(2)}. Verify its payout % was entered correctly.`,
      });
      break; // one suggestion of this kind is enough
    }
  }

  // ── MISSING_DEPOSIT ──
  if (difference.gt(0)) {
    const hasRecentDeposit = input.transactions.some(
      (t) => t.type === "DEPOSIT" && (t.occurredAt ?? new Date(0)) >= cutoff,
    );
    if (!hasRecentDeposit) {
      out.push({
        kind: "MISSING_DEPOSIT",
        title: "Missing deposit?",
        detail: `Broker shows ${difference.toFixed(2)} more than our books, and no deposit was recorded in the last ${lookbackDays} days. Did you add funds to the broker without logging it here?`,
      });
    }
  }

  // ── MISSING_WITHDRAWAL ──
  if (difference.lt(0)) {
    const hasRecentWithdrawal = input.transactions.some(
      (t) => t.type === "WITHDRAWAL" && (t.occurredAt ?? new Date(0)) >= cutoff,
    );
    if (!hasRecentWithdrawal) {
      out.push({
        kind: "MISSING_WITHDRAWAL",
        title: "Missing withdrawal?",
        detail: `Broker shows ${difference.abs().toFixed(2)} less than our books, and no withdrawal was recorded in the last ${lookbackDays} days. Did you take money out without logging it here?`,
      });
    }
  }

  // ── MATCHES_STAKE ──
  const commonStakes = (input.commonStakes ?? []).map((s) => new Decimal(s.toString()));
  for (const stake of commonStakes) {
    if (stake.lte(0)) continue;
    const distance = stake.minus(absDiff).abs();
    if (distance.lte(stake.times(0.05)) || distance.lte(stakeAbsTol)) {
      out.push({
        kind: "MATCHES_STAKE",
        title: "Matches a stake amount",
        detail: `The difference of ${difference.abs().toFixed(2)} is close to a stake of ${stake.toFixed(2)} you've used recently. Could be a missed trade outcome at this stake.`,
      });
      break; // one match is enough
    }
  }

  // ── GAP_DAY ──
  // Build a set of day-keys that have either a transaction or a trade.
  const daysWithActivity = new Set<string>();
  for (const t of input.transactions) {
    const d = t.occurredAt;
    if (!d) continue;
    daysWithActivity.add(dayKey(d));
  }
  for (const t of input.trades) {
    const d = t.openedAt ?? t.closedAt;
    if (!d) continue;
    daysWithActivity.add(dayKey(d));
  }
  // Walk the lookback window day-by-day; flag the first day with no activity.
  for (let i = 0; i < lookbackDays; i++) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    day.setUTCHours(0, 0, 0, 0);
    if (!daysWithActivity.has(dayKey(day))) {
      out.push({
        kind: "GAP_DAY",
        title: "Gap day in the journal",
        detail: `${day.toISOString().slice(0, 10)} has no trades and no transactions recorded. Did you trade that day but forget to log it?`,
      });
      break; // one gap day is enough
    }
  }

  return out;
}

function dayKey(d: Date): string {
  const copy = new Date(d.getTime());
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}
