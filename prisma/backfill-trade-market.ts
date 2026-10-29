/**
 * Phase 29 — Backfill market-condition snapshots for pre-existing trades.
 *
 * Usage:
 *   bun run prisma/backfill-trade-market.ts            # backfill everything
 *   bun run prisma/backfill-trade-market.ts --dry-run  # report only
 *   bun run prisma/backfill-trade-market.ts --limit 50 # cap trade count
 *
 * A trade is "unprocessed" while `marketRating IS NULL AND marketDataMissing
 * = false` (the state every pre-Phase-29 row starts in). For each one:
 *
 *   1. Resolve the asset to an Instrument (OTC / free-text assets don't
 *      match) — no match → marketDataMissing = true (never faked).
 *   2. Load the pair's M5 candles over the same 20-day lookback the live
 *      worker uses, sliced to `time <= openedAt` so the computation only
 *      sees what was knowable AT the trade's open.
 *   3. Run the SAME pure pipeline the worker runs
 *      (buildConditionContext → conditionScore → computeConditionMeta) at
 *      `now = openedAt` — real candles, real rating, no guessing.
 *   4. No candles for that lookback → marketDataMissing = true (flagged, not
 *      fabricated).
 *
 * Idempotent: after a run every trade either has a snapshot or
 * marketDataMissing = true, so re-runs find nothing to do.
 */
import { PrismaClient } from "@prisma/client";

import {
  buildConditionContext,
  computeConditionMeta,
  conditionScore,
  CONDITION_GRANULARITY,
  CONDITION_LOOKBACK_DAYS,
  MAX_CONDITION_CANDLES,
} from "../src/lib/market/condition-input";
import {
  snapshotFromCondition,
  noDataSnapshot,
  normalizeAssetToSymbol,
} from "../src/lib/market/trade-snapshot";
import { isMarketClosed } from "../src/lib/market/market-hours";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  if (i === -1) return null;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

type TradeRow = {
  id: string;
  asset: string;
  openedAt: Date;
};

async function main() {
  const unprocessed = await prisma.trade.findMany({
    where: { marketRating: null, marketDataMissing: false },
    orderBy: { openedAt: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
    select: { id: true, asset: true, openedAt: true },
  });
  console.log(`Unprocessed trades: ${unprocessed.length}${DRY_RUN ? " (dry run)" : ""}`);
  if (unprocessed.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const instruments = await prisma.instrument.findMany({
    select: { id: true, symbol: true, isActive: true },
  });
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  // One news fetch covering the whole backfill range (newsProximity filters
  // to upcoming events per trade internally).
  const minT = unprocessed[0].openedAt;
  const maxT = unprocessed[unprocessed.length - 1].openedAt;
  const newsRows = await prisma.newsEvent.findMany({
    where: { scheduledAt: { gte: minT, lte: new Date(maxT.getTime() + 2 * 60 * 60 * 1000) } },
    orderBy: { scheduledAt: "asc" },
    select: { currency: true, title: true, impact: true, scheduledAt: true },
  });

  let snapshotted = 0;
  let missing = 0;

  for (const trade of unprocessed) {
    const symbol = normalizeAssetToSymbol(trade.asset);
    const instrument = bySymbol.get(symbol);
    const snapshot = instrument
      ? await computeFromCandles(instrument.id, symbol, trade.openedAt, newsRows)
      : noDataSnapshot();

    if (snapshot.marketDataMissing) missing++;
    else snapshotted++;

    if (!DRY_RUN) {
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          marketRating: snapshot.marketRating,
          marketScore: snapshot.marketScore,
          volatilityPercentile: snapshot.volatilityPercentile,
          marketSession: snapshot.marketSession,
          marketDataMissing: snapshot.marketDataMissing,
        },
      });
    }
  }

  console.log(
    `${DRY_RUN ? "[dry-run] Would backfill" : "Backfilled"} ${snapshotted} trade(s) from candles; ` +
      `${missing} flagged as no-data (unknown instrument or no candle history).`,
  );
  await prisma.$disconnect();
}

async function computeFromCandles(
  instrumentId: string,
  symbol: string,
  openedAt: Date,
  newsRows: Array<{ currency: string; title: string; impact: string; scheduledAt: Date }>,
) {
  const since = new Date(openedAt.getTime() - CONDITION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.candle.findMany({
    where: {
      instrumentId,
      granularity: CONDITION_GRANULARITY,
      time: { gte: since, lte: openedAt },
    },
    orderBy: { time: "asc" },
    take: MAX_CONDITION_CANDLES,
    select: {
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      bid: true,
      ask: true,
    },
  });
  // Nothing to rank against → no data (never a fabricated rating).
  if (rows.length < 2) return noDataSnapshot();

  const ctx = buildConditionContext({
    pair: symbol,
    now: openedAt,
    candleRows: rows,
    lastSuccessAt: null,
    newsRows,
    marketClosed: isMarketClosed(openedAt),
  });
  const result = conditionScore(ctx);
  const meta = computeConditionMeta(ctx, result.factors);

  return snapshotFromCondition(
    {
      rating: result.rating,
      score: result.score,
      meta,
      computedAt: openedAt, // computed fresh for this instant → not stale
    },
    openedAt,
  );
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
