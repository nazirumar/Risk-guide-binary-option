/**
 * Shared types for the Phase 6 calculation engine.
 *
 * All calc modules accept "lite" trade shapes so they can be called from:
 *   - production code that reads Prisma Trade rows (with Decimal fields)
 *   - unit tests with plain JS objects (no Prisma import)
 *
 * The `profitLoss` is always the SIGNED realized P/L:
 *   WIN  → +stake × payout
 *   LOSS → -stake
 *   TIE  → 0
 *   OPEN → 0 (not realized yet — filter out before analytics)
 *
 * `result` is required so rates/streaks work; the other fields are optional
 * and only needed by specific groupings.
 */
import type Decimal from "decimal.js";
import type { TradeDirection, TradeResult } from "@prisma/client";

export type TradeLike = {
  /** Signed realized profit/loss. Positive for wins, negative for losses, 0 for ties. */
  profitLoss: Decimal | string | number;
  /** Result enum — OPEN trades contribute 0 P/L and should be filtered before analytics. */
  result?: TradeResult;
  /** Stake in account currency — used by expectancy-in-R and risk-of-ruin. */
  stake?: Decimal | string | number;
  /** Broker payout fraction (e.g. 0.85 = 85%) — used by expectancy + risk-of-ruin. */
  payoutPercent?: Decimal | string | number;
  /** When the trade opened — used by hour-of-day / day-of-week groupings + equity walk. */
  openedAt?: Date;
  /** Asset symbol — used by groupByAsset. */
  asset?: string;
  /** Strategy name (denormalized from the join) — used by groupByStrategy. */
  strategy?: string | null;
  /** Emotion enum — used by groupByEmotion. */
  emotion?: string | null;
  /** CALL or PUT — used by groupByDirection. */
  direction?: TradeDirection;
};

/**
 * Normalized trade shape returned by `normalizeTrades()` — converts all
 * Decimal-ish fields to plain `number` for math, drops OPEN trades, and
 * sorts by openedAt asc so equity walks + streaks work in chronological
 * order.
 */
export type NormalizedTrade = {
  profitLoss: number;
  result: "WIN" | "LOSS" | "TIE";
  stake: number;
  payoutPercent: number;
  openedAt: Date;
  asset: string;
  strategy: string | null;
  emotion: string | null;
  direction: "CALL" | "PUT";
};
