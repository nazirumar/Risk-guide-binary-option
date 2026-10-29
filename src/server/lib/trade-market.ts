/**
 * Phase 29 — Trade-time market condition lookup (server-only, shared).
 *
 * (PROJECT_RULES.md rule #3: reads here are NOT user-scoped — MarketCondition
 * rows are global instrument data, but every helper is only reachable from
 * authed actions/pages. rule #11: outputs are descriptive snapshots.)
 *
 * Consumers:
 *   - `createTradeAction` — snapshots the condition onto the trade at save.
 *   - `prepareTradeConfirmationAction` — rating + edge info on the Phase 17
 *     pre-trade screen.
 *   - `getMarketEdgeAction` — the live badge + AVOID dialog in Add Trade.
 *   - the backfill script — never; that one computes from candles.
 *
 * All staleness/rating validation happens in the pure
 * `@/lib/market/trade-snapshot` — this module only reads rows and assembles.
 */
import { db } from "@/lib/db";
import {
  normalizeAssetToSymbol,
  normalizeRating,
  snapshotFromCondition,
  noDataSnapshot,
  type TradeMarketSnapshot,
} from "@/lib/market/trade-snapshot";
import { classifyTradeBySession, type SessionKey } from "@/lib/news/sessions";
import { groupEdge, type EdgeGroup, type EdgeTradeInput } from "@/lib/calc/edge";
import { avoidConfirmationRequired } from "@/lib/market/trade-snapshot";
import type { PrepareMarketInfo } from "@/server/actions/pre-trade-types";

/** The live condition for a trade asset, already trusted (fresh + known
 *  rating). null = no data (OTC, unknown instrument, stale or bad row). */
export type LivePairCondition = {
  instrumentId: string;
  symbol: string;
  rating: "GOOD" | "CAUTION" | "AVOID";
  score: number;
  volatilityPercentile: number | null;
  session: string;
  reasons: string[];
  nextNewsTitle: string | null;
  nextNewsMinutesTo: number | null;
  computedAt: Date;
};

/**
 * Read the pair's current MarketCondition for a trade asset. Returns null
 * when the instrument has no row or the row fails the pure trust checks
 * (stale / unknown rating) — callers must never invent data instead.
 */
export async function getLivePairCondition(
  asset: string,
  now: Date = new Date(),
): Promise<LivePairCondition | null> {
  const symbol = normalizeAssetToSymbol(asset);
  const condition = await db.marketCondition.findFirst({
    where: { instrument: { symbol, isActive: true } },
    select: {
      instrumentId: true,
      score: true,
      rating: true,
      meta: true,
      computedAt: true,
      reasons: true,
      instrument: { select: { symbol: true } },
    },
  });
  if (!condition) return null;

  // The pure builder performs the staleness + rating trust checks.
  const snapshot = snapshotFromCondition(
    { rating: condition.rating, score: condition.score, meta: condition.meta, computedAt: condition.computedAt },
    now,
  );
  if (snapshot.marketDataMissing) return null;

  const meta = (condition.meta ?? null) as Record<string, unknown> | null;
  const nextNewsTitle = typeof meta?.nextNewsTitle === "string" ? meta.nextNewsTitle : null;
  const nextNewsRaw = meta?.nextNewsMinutesTo;
  const nextNewsMinutesTo = typeof nextNewsRaw === "number" && Number.isFinite(nextNewsRaw)
    ? nextNewsRaw
    : null;

  return {
    instrumentId: condition.instrumentId,
    symbol: condition.instrument.symbol,
    rating: snapshot.marketRating as "GOOD" | "CAUTION" | "AVOID",
    score: snapshot.marketScore ?? condition.score,
    volatilityPercentile: snapshot.volatilityPercentile,
    session: snapshot.marketSession ?? "OFF_HOURS",
    reasons: Array.isArray(condition.reasons) ? (condition.reasons as string[]) : [],
    nextNewsTitle,
    nextNewsMinutesTo,
    computedAt: condition.computedAt,
  };
}

/** The snapshot fields to persist onto a Trade row for this asset. */
export async function getTradeMarketSnapshot(
  asset: string,
  now: Date = new Date(),
): Promise<TradeMarketSnapshot> {
  const live = await getLivePairCondition(asset, now);
  if (!live) return noDataSnapshot();
  return {
    marketRating: live.rating,
    marketScore: live.score,
    volatilityPercentile: live.volatilityPercentile,
    marketSession: live.session,
    marketDataMissing: false,
  };
}

/** How many of a user's closed trades to scan for personal pair/session
 *  records. Well above EDGE_MIN_SAMPLE so even exotic pairs resolve. */
const PERSONAL_SCAN_LIMIT = 1000;

/**
 * The user's own historical result for `asset` within `sessionKey`, grouped
 * with the Phase 20 statistics. Returns null when the group is INSUFFICIENT
 * (< 30 trades) — surfaces that would invite conclusions off tiny samples
 * stay hidden (the caller shows "need more trades" copy instead).
 */
export async function getPersonalPairSessionRecord(
  userId: string,
  asset: string,
  sessionKey: SessionKey | string,
  now: Date = new Date(),
): Promise<EdgeGroup | null> {
  const rows = await db.trade.findMany({
    where: {
      userId,
      asset,
      result: { in: ["WIN", "LOSS", "TIE"] },
      openedAt: { lte: now },
    },
    orderBy: { openedAt: "desc" },
    take: PERSONAL_SCAN_LIMIT,
    select: {
      openedAt: true,
      result: true,
      profitLoss: true,
      payoutPercent: true,
      marketSession: true,
    },
  });

  const scoped: EdgeTradeInput[] = [];
  for (const r of rows) {
    // Snapshot session when present; otherwise classify from the open time —
    // session boundaries are derivable for any historical trade.
    const session = r.marketSession ?? classifyTradeBySession(r.openedAt);
    if (session !== sessionKey) continue;
    scoped.push({
      pair: asset,
      session,
      hour: r.openedAt.getUTCHours(),
      rating: null, // not used by this grouping
      volatilityPercentile: null,
      pnl: Number(r.profitLoss.toString()),
      win: r.result === "WIN",
      payoutPercent: Number(r.payoutPercent.toString()),
    });
  }
  if (scoped.length === 0) return null;

  const [group] = groupEdge(scoped, () => String(sessionKey));
  if (!group || group.trades < 30) return null;
  return group;
}

// ─── Market-warning settings + the shared prepare-info block ────────────────

export type MarketWarningSettings = {
  warningsEnabled: boolean;
  ignoreAvoidOnDemo: boolean;
  avoidOverrideWeight: number;
};

/** Phase 29 user settings with model defaults (missing row never crashes). */
export async function getMarketWarningSettings(userId: string): Promise<MarketWarningSettings> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      marketWarningsEnabled: true,
      marketWarningsIgnoreAvoidDemo: true,
      avoidOverrideWeight: true,
    },
  });
  return {
    warningsEnabled: user?.marketWarningsEnabled ?? true,
    ignoreAvoidOnDemo: user?.marketWarningsIgnoreAvoidDemo ?? false,
    avoidOverrideWeight: Math.min(10, Math.max(0, user?.avoidOverrideWeight ?? 5)),
  };
}

/**
 * The market block shared by the Phase 17 prepare step and the Add Trade
 * warning panel: live condition + personal pair×session record + the
 * server-side AVOID-dialog decision (so the client can't disagree with the
 * server about whether the warning applies).
 */
export async function buildMarketWarningInfo(
  userId: string,
  asset: string,
  accountType: "DEMO" | "REAL",
  now: Date = new Date(),
): Promise<PrepareMarketInfo> {
  const [settings, live] = await Promise.all([
    getMarketWarningSettings(userId),
    getLivePairCondition(asset, now),
  ]);

  const session = live?.session ?? classifyTradeBySession(now);
  const personal = await getPersonalPairSessionRecord(userId, asset, session, now);

  if (!live) {
    // OTC / unknown instrument / stale feed — never a guessed rating.
    return {
      hasData: false,
      avoidConfirmRequired: false,
      session,
      personal: personal ? personalRecord(personal) : null,
    };
  }

  return {
    hasData: true,
    rating: live.rating,
    score: live.score,
    volatilityPercentile: live.volatilityPercentile,
    session: live.session,
    reasons: live.reasons,
    nextNewsTitle: live.nextNewsTitle,
    nextNewsMinutesTo: live.nextNewsMinutesTo,
    avoidConfirmRequired: avoidConfirmationRequired({
      rating: live.rating,
      warningsEnabled: settings.warningsEnabled,
      accountType,
      ignoreAvoidOnDemo: settings.ignoreAvoidOnDemo,
    }),
    personal: personal ? personalRecord(personal) : null,
  };
}

function personalRecord(group: EdgeGroup): NonNullable<PrepareMarketInfo["personal"]> {
  return {
    trades: group.trades,
    winRate: group.winRate,
    winRateLow: group.winRateLow,
    winRateHigh: group.winRateHigh,
    expectancy: group.expectancy,
    reliability: group.reliability,
  };
}
