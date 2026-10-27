/**
 * Pure account-balance calculation helpers (PROJECT_RULES.md rule #2 + rule #9).
 *
 * The "always-recompute" rule: the TradingAccount.currentBalance is NEVER
 * written directly by user-facing flows. It is ALWAYS derived from:
 *
 *     currentBalance = startingBalance
 *                      + sum(transactions.amount)        // signed: deposit +, withdrawal -, bonus +, adjustment ±
 *                      + sum(trades.profitLoss)          // signed: win +, loss -, tie 0
 *
 * Every state change (create/edit/delete a transaction OR a trade) opens a
 * `prisma.$transaction` and:
 *   1. Mutates the row
 *   2. Re-fetches all transactions + trades for the account
 *   3. Calls recomputeAccountBalance() to derive the new currentBalance
 *   4. Recomputes every trade's `balanceAfter` (the equity walk)
 *   5. Commits
 *
 * This module is intentionally DB-free and pure — given the inputs, the
 * outputs are deterministic. Unit tests assert on the math; the server
 * actions assert the persistence + atomicity.
 */
import Decimal from "decimal.js";

// ─── Input types — minimal shapes so we can call from tests with plain
// objects without spinning up Prisma. ──────────────────────────────────────

export type TransactionLike = {
  type: "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT";
  amount: Decimal | string | number;
};

export type TradeLike = {
  profitLoss: Decimal | string | number;
};

export type TransactionWithDate = TransactionLike & {
  occurredAt?: Date;
};

export type TradeWithDate = TradeLike & {
  openedAt?: Date;
};

// ─── Per-transaction signed contribution ────────────────────────────────────

/**
 * Convert a Transaction's `amount` to a signed contribution:
 *   - DEPOSIT    → +amount  (you added money to the broker)
 *   - WITHDRAWAL → -amount  (you took money out)
 *   - BONUS      → +amount  (broker credited you)
 *   - ADJUSTMENT → +amount  (signed reconciliation adjustment: + or -)
 *
 * Note: ADJUSTMENT amounts in our schema are signed — the caller passes the
 * raw signed value (positive = "broker shows more than our books", negative
 * = "broker shows less"). We do NOT negate the absolute value here.
 */
export function signedTransactionAmount(t: TransactionLike): Decimal {
  const amount = new Decimal(t.amount.toString());
  switch (t.type) {
    case "DEPOSIT":
    case "BONUS":
    case "ADJUSTMENT":
      return amount;
    case "WITHDRAWAL":
      return amount.neg();
    default:
      // Unknown types contribute 0 — caller should validate.
      return new Decimal(0);
  }
}

// ─── Account-level balance ──────────────────────────────────────────────────

/**
 * Recompute an account's current balance from its starting balance + the
 * signed sum of all transactions + the signed sum of all trade P/L.
 *
 * Pure: no DB access, no side effects, deterministic for the same inputs.
 */
export function recomputeAccountBalance(
  startingBalance: Decimal | string | number,
  transactions: TransactionLike[],
  trades: TradeLike[],
): Decimal {
  const start = new Decimal(startingBalance.toString());
  const txSum = transactions.reduce(
    (acc, t) => acc.plus(signedTransactionAmount(t)),
    new Decimal(0),
  );
  const tradeSum = trades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  return start.plus(txSum).plus(tradeSum);
}

/**
 * Recompute the per-trade `balanceAfter` equity walk — given a starting
 * balance and a list of (signed) trade P/Ls in chronological order, returns
 * the running balance after each trade. Used by Phase 5 (trade journal) and
 * by Phase 9 (equity curve) — declared here because the math is shared with
 * account-balance.
 */
export function equityWalk(
  startingBalance: Decimal | string | number,
  tradePLs: TradeWithDate[],
): Decimal[] {
  let running = new Decimal(startingBalance.toString());
  const sorted = [...tradePLs].sort((a, b) => {
    const at = a.openedAt?.getTime() ?? 0;
    const bt = b.openedAt?.getTime() ?? 0;
    return at - bt;
  });
  return sorted.map((t) => {
    running = running.plus(new Decimal(t.profitLoss.toString()));
    return running;
  });
}

/**
 * Compute "today P/L" — sum of trade profit/loss for trades that opened today
 * (in the user's timezone, although the pure helper just uses UTC midnight
 * for the cutoff — callers pass trades already filtered by their timezone).
 */
export function todayPL(trades: TradeWithDate[]): Decimal {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  return trades
    .filter((t) => (t.openedAt ?? new Date(0)) >= startOfToday)
    .reduce((acc, t) => acc.plus(new Decimal(t.profitLoss.toString())), new Decimal(0));
}

/**
 * Compute the difference between a user-entered "broker real balance" and
 * our computed current balance. Positive = broker shows MORE than our books
 * (we under-counted somewhere; positive ADJUSTMENT needed). Negative = broker
 * shows LESS (we over-counted; negative ADJUSTMENT needed).
 */
export function reconcileDifference(
  computedBalance: Decimal | string | number,
  brokerBalance: Decimal | string | number,
): Decimal {
  return new Decimal(brokerBalance.toString()).minus(new Decimal(computedBalance.toString()));
}

/**
 * Validates a withdrawal can't exceed the current balance — used to warn
 * before allowing a withdrawal that would put the account negative. The
 * app doesn't hard-block this (brokers allow overdraft in some scenarios)
 * but warns the user.
 */
export function withdrawalWouldExceedBalance(
  currentBalance: Decimal | string | number,
  withdrawalAmount: Decimal | string | number,
): boolean {
  return new Decimal(withdrawalAmount.toString()).gt(new Decimal(currentBalance.toString()));
}
