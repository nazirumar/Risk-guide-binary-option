/**
 * Phase 17 — Pre-trade confirmation summary math.
 *
 * Pure function: `buildConfirmationSummary(input)` computes every number the
 * confirmation modal shows, with Decimal precision (rule #1 — never Float for
 * money). No DB, no side effects — the server action fetches the raw inputs
 * (balance, daily P/L, limits, tilt level, plan suggestion) and this function
 * derives the display values.
 *
 * Derived values:
 *   - potentialProfit / potentialLoss   (reuses calc/trade.ts)
 *   - stakePercentOfBalance             (reuses riskAsPercentOfBalance)
 *   - dailyLossUsedPercent              (0 when no loss yet; null = no limit set)
 *   - tradesRemainingToday              (max - used, floored at 0)
 *   - planMatch                         (stake vs staking-plan suggestion)
 */
import Decimal from "decimal.js";

import { potentialProfit, potentialLoss, riskAsPercentOfBalance, breakEvenWinRate } from "./trade";

export type ConfirmationSummaryInput = {
  /** Trade parameters as entered in the form. */
  stake: Decimal | string | number;
  payoutPercent: Decimal | string | number;
  asset: string;
  direction: "CALL" | "PUT";
  expiryMinutes: number;

  /** Account state. */
  balance: Decimal | string | number;
  currency: string;

  /** Today's net P/L for the account (negative = losing day). */
  dailyPL: Decimal | string | number;

  /** Risk limits — null/undefined = rule not configured. */
  maxDailyLossPercent: Decimal | string | number | null;
  maxDailyLossAmount: Decimal | string | number | null;
  maxTradesPerDay: number;
  tradesToday: number;

  /** Current consecutive-loss streak (0 = none). */
  currentLossStreak: number;

  /** Tilt detection result (Phase 16). */
  tiltLevel: "CALM" | "CAUTION" | "TILT";
  tiltScore: number;

  /** Staking-plan suggestion (Phase 8) — null = no default plan. */
  planSuggestedStake: string | null;
  planName: string | null;
};

export type ConfirmationPlanMatch = {
  /** true when the entered stake equals the plan suggestion (2dp). */
  matches: boolean;
  /** true when no default plan exists — nothing to compare against. */
  hasPlan: boolean;
  suggestedStake: string | null;
  planName: string | null;
  /** entered stake − suggested stake (positive = above plan). */
  deviation: string | null;
  /** deviation as a fraction of the suggestion (e.g. 0.25 = +25%). */
  deviationPercent: string | null;
};

export type ConfirmationSummary = {
  stake: string;
  payoutPercent: string;
  asset: string;
  direction: "CALL" | "PUT";
  expiryMinutes: number;
  currency: string;

  potentialProfit: string;
  potentialLoss: string;
  stakePercentOfBalance: string;
  breakEvenWinRate: string;

  /** How much of the daily loss limit is already used, as a fraction 0–1+. Null = no limit. */
  dailyLossUsedPercent: string | null;
  /** Today's net P/L (signed string, e.g. "-12.50"). */
  dailyPL: string;
  /** maxTradesPerDay − tradesToday, floored at 0. */
  tradesRemainingToday: number;
  tradesToday: number;
  maxTradesPerDay: number;
  currentLossStreak: number;

  tiltLevel: "CALM" | "CAUTION" | "TILT";
  tiltScore: number;

  plan: ConfirmationPlanMatch;
};

function dec(v: Decimal | string | number | null | undefined): Decimal {
  if (v === null || v === undefined) return new Decimal(0);
  if (v instanceof Decimal) return v;
  try {
    return new Decimal(v.toString());
  } catch {
    return new Decimal(0);
  }
}

/**
 * Build the full confirmation summary. All monetary outputs are 2dp strings;
 * percents are fractions (0.02 = 2%) as 4dp strings so the UI formats them
 * with formatPercent().
 */
export function buildConfirmationSummary(input: ConfirmationSummaryInput): ConfirmationSummary {
  const stake = dec(input.stake).toDecimalPlaces(2);
  const payout = dec(input.payoutPercent).toDecimalPlaces(4);
  const balance = dec(input.balance);
  const dailyPL = dec(input.dailyPL).toDecimalPlaces(2);

  const profit = potentialProfit(stake, payout).toDecimalPlaces(2);
  const loss = potentialLoss(stake).toDecimalPlaces(2);
  const stakePct = riskAsPercentOfBalance(stake, balance).toDecimalPlaces(6);

  // ─── Daily loss used % ─────────────────────────────────────────────────
  // Loss so far today = max(0, −dailyPL). Used% = lossSoFar / limit.
  // The limit is whichever of (percent × balance, flat amount) is SMALLER —
  // matching evaluateRisk, where either cap can block independently. If no
  // limit is configured, used% is null and the modal shows raw P/L instead.
  const lossSoFar = dailyPL.lt(0) ? dailyPL.abs() : new Decimal(0);
  let dailyLossUsedPercent: string | null = null;
  const pctLimit =
    input.maxDailyLossPercent !== null && input.maxDailyLossPercent !== undefined
      ? dec(input.maxDailyLossPercent).div(100).mul(balance)
      : null;
  const amtLimit =
    input.maxDailyLossAmount !== null && input.maxDailyLossAmount !== undefined
      ? dec(input.maxDailyLossAmount)
      : null;
  const limits = [pctLimit, amtLimit].filter((l): l is Decimal => l !== null && l.gt(0));
  if (limits.length > 0) {
    const effectiveLimit = limits.reduce((a, b) => (a.lt(b) ? a : b));
    dailyLossUsedPercent = lossSoFar.div(effectiveLimit).toDecimalPlaces(6).toString();
  }

  // ─── Trades remaining today ────────────────────────────────────────────
  const tradesRemainingToday = Math.max(0, input.maxTradesPerDay - input.tradesToday);

  // ─── Plan match ────────────────────────────────────────────────────────
  const hasPlan =
    input.planSuggestedStake !== null &&
    input.planSuggestedStake !== undefined &&
    input.planName !== null &&
    input.planName !== undefined;
  let plan: ConfirmationPlanMatch;
  if (hasPlan) {
    const suggested = dec(input.planSuggestedStake).toDecimalPlaces(2);
    const deviation = stake.minus(suggested).toDecimalPlaces(2);
    const deviationPercent = suggested.gt(0)
      ? deviation.div(suggested).toDecimalPlaces(6).toString()
      : "0";
    plan = {
      matches: deviation.eq(0),
      hasPlan: true,
      suggestedStake: suggested.toFixed(2),
      planName: input.planName,
      deviation: deviation.toFixed(2),
      deviationPercent,
    };
  } else {
    plan = {
      matches: false,
      hasPlan: false,
      suggestedStake: null,
      planName: null,
      deviation: null,
      deviationPercent: null,
    };
  }

  return {
    // .toFixed(2) keeps trailing zeros — the modal shows "$10.00", not "$10".
    stake: stake.toFixed(2),
    payoutPercent: payout.toString(),
    asset: input.asset,
    direction: input.direction,
    expiryMinutes: input.expiryMinutes,
    currency: input.currency,

    potentialProfit: profit.toFixed(2),
    // potentialLoss is negative (e.g. "-10.00") — same semantics as the
    // Add Trade form's live preview, so the modal renders identical values.
    potentialLoss: loss.toFixed(2),
    stakePercentOfBalance: stakePct.toString(),
    breakEvenWinRate: breakEvenWinRate(payout).toDecimalPlaces(6).toString(),

    dailyLossUsedPercent,
    dailyPL: dailyPL.toFixed(2),
    tradesRemainingToday,
    tradesToday: input.tradesToday,
    maxTradesPerDay: input.maxTradesPerDay,
    currentLossStreak: input.currentLossStreak,

    tiltLevel: input.tiltLevel,
    tiltScore: input.tiltScore,

    plan,
  };
}
