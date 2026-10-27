/**
 * Pure trade-calculation helpers (PROJECT_RULES.md rule #2: pure functions in
 * `/src/lib/calc`, fully unit-tested).
 *
 * Phase 5: stake sizing, payout-based profit/loss, risk-as-percent.
 *
 * Conventions:
 *   - `payoutPercent` is a fraction (0.85 = 85% broker payout).
 *   - `stake` is always positive (the form collects a positive amount).
 *   - Result is "WIN" | "LOSS" | "TIE" | "OPEN".
 *
 * Math:
 *   WIN  → profitLoss = +stake * payoutPercent   (you get stake back + profit)
 *   LOSS → profitLoss = -stake                    (you lose the stake)
 *   TIE  → profitLoss = 0                          (refund — most brokers)
 *   OPEN → profitLoss = 0                          (not closed yet, no realized P/L)
 */
import Decimal from "decimal.js";

export type TradeResult = "WIN" | "LOSS" | "TIE" | "OPEN";

/**
 * Compute the signed profit/loss for a closed trade.
 *
 * For OPEN trades, returns 0 (no realized P/L yet).
 */
export function computeTradeProfitLoss(
  stake: Decimal | string | number,
  payoutPercent: Decimal | string | number,
  result: TradeResult,
): Decimal {
  const s = new Decimal(stake.toString());
  const p = new Decimal(payoutPercent.toString());
  switch (result) {
    case "WIN":
      // WIN: you get stake × payout back. Profit = stake × payout%.
      return s.mul(p);
    case "LOSS":
      // LOSS: you lose the stake.
      return s.neg();
    case "TIE":
    case "OPEN":
    default:
      return new Decimal(0);
  }
}

/**
 * Compute the *potential* profit if the trade wins — used by the Add Trade
 * form's live preview. Same as `computeTradeProfitLoss` for "WIN" but renamed
 * to make the call site readable.
 */
export function potentialProfit(
  stake: Decimal | string | number,
  payoutPercent: Decimal | string | number,
): Decimal {
  return computeTradeProfitLoss(stake, payoutPercent, "WIN");
}

/**
 * Compute the *potential* loss if the trade loses — used by the Add Trade
 * form's live preview. Always equals `-stake`.
 */
export function potentialLoss(stake: Decimal | string | number): Decimal {
  return new Decimal(stake.toString()).neg();
}

/**
 * Risk as a percentage of the current balance. Returns a fraction
 * (e.g. 0.02 = 2%). Used by the Add Trade form preview + Phase 7's
 * `evaluateRisk` to compare against the per-trade risk limit.
 */
export function riskAsPercentOfBalance(
  stake: Decimal | string | number,
  balance: Decimal | string | number,
): Decimal {
  const s = new Decimal(stake.toString());
  const b = new Decimal(balance.toString());
  if (b.isZero()) {
    return new Decimal(0); // avoid divide-by-zero on a fresh $0 account
  }
  return s.div(b);
}

/**
 * Break-even win rate for a given payout: the win-rate at which the trader's
 * expectancy is exactly zero. Defined as 1 / (1 + payout).
 *
 * E.g. 85% payout → break-even ≈ 54.05%. The full Phase 6 calculation engine
 * will use this; declaring it here so Phase 5 can show it in the Add Trade
 * form's preview as "you need to win X% of the time to break even."
 */
export function breakEvenWinRate(payoutPercent: Decimal | string | number): Decimal {
  const p = new Decimal(payoutPercent.toString());
  return new Decimal(1).div(new Decimal(1).plus(p));
}
