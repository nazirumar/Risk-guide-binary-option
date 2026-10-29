/**
 * Phase 29 — Market Edge report loader (server-only).
 *
 * (PROJECT_RULES.md rule #3: every query is userId-scoped; rule #11: the
 * report is built by the PURE `@/lib/calc/edge` — this module only loads
 * rows and maps them.)
 *
 * Closed trades → EdgeTradeInput:
 *   - session: the Phase 29 snapshot when present, else classified from the
 *     open time (session boundaries are derivable for ANY historical trade —
 *     pre-snapshot rows still group correctly).
 *   - rating: normalized GOOD/CAUTION/AVOID, else null → "No data" group.
 *   - pnl/payout: plain numbers for analytics display (never for accounting).
 */
import { db } from "@/lib/db";
import { buildEdgeReport, type EdgeReport, type EdgeTradeInput } from "@/lib/calc/edge";
import { classifyTradeBySession, hourInTz } from "@/lib/news/sessions";
import { normalizeRating } from "@/lib/market/trade-snapshot";

/** Newest-N cap — well above what the tables need, bounded for perf. */
const REPORT_TRADE_LIMIT = 5000;

export async function getMarketEdgeReport(
  userId: string,
  timezone: string,
): Promise<EdgeReport> {
  const rows = await db.trade.findMany({
    where: {
      userId,
      result: { in: ["WIN", "LOSS", "TIE"] },
    },
    orderBy: { openedAt: "desc" },
    take: REPORT_TRADE_LIMIT,
    select: {
      asset: true,
      openedAt: true,
      result: true,
      profitLoss: true,
      payoutPercent: true,
      marketRating: true,
      marketSession: true,
      volatilityPercentile: true,
    },
  });

  const trades: EdgeTradeInput[] = rows.map((r) => ({
    pair: r.asset,
    session: r.marketSession ?? classifyTradeBySession(r.openedAt),
    hour: hourInTz(r.openedAt, timezone || "UTC"),
    rating: normalizeRating(r.marketRating),
    volatilityPercentile: r.volatilityPercentile,
    pnl: Number(r.profitLoss.toString()),
    win: r.result === "WIN",
    payoutPercent: Number(r.payoutPercent.toString()),
  }));

  return buildEdgeReport(trades);
}
