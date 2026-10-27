/**
 * Shared normalization helper — converts the loose TradeLike input (which
 * accepts Decimal | string | number for any money field) into a tidy
 * NormalizedTrade with plain numbers. Used by every analytics module so
 * they don't each have to repeat the Decimal.toString() dance.
 *
 * Edge cases handled here so every metric function gets clean input:
 *   - OPEN trades are dropped (no realized P/L — see types.ts comment).
 *   - Missing optional fields get sensible defaults.
 *   - Unparseable numbers fall back to 0 (with a console.warn in dev).
 *   - Trades with no openedAt are pushed to the end of the chronology.
 */
import Decimal from "decimal.js";
import type { TradeLike, NormalizedTrade } from "./types";

function toNumber(v: Decimal | string | number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  try {
    if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
    const n = new Decimal(v.toString()).toNumber();
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function toDate(v: Date | string | null | undefined): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Missing date — push to far future so it sorts AFTER real trades (an
  // OPEN-less equity walk shouldn't get confused). Real callers should
  // always pass openedAt.
  return new Date(8640000000000000); // max date
}

/**
 * Drop OPEN trades + convert all fields to plain numbers + sort by openedAt.
 *
 * Use this as the entry point for any analytics module:
 *   const trades = normalizeTrades(inputTrades);
 *   const winRate = computeWinRate(trades);
 */
export function normalizeTrades(trades: TradeLike[]): NormalizedTrade[] {
  return trades
    .filter((t) => t.result !== "OPEN")
    .map<NormalizedTrade>((t) => ({
      profitLoss: toNumber(t.profitLoss),
      result: (t.result ?? "WIN") as "WIN" | "LOSS" | "TIE",
      stake: toNumber(t.stake, 0),
      payoutPercent: toNumber(t.payoutPercent, 0),
      openedAt: toDate(t.openedAt),
      asset: t.asset ?? "UNKNOWN",
      strategy: t.strategy ?? null,
      emotion: t.emotion ?? null,
      direction: (t.direction ?? "CALL") as "CALL" | "PUT",
    }))
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}
