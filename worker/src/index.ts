import { PrismaClient } from "@prisma/client";
import { getMarketProvider, MarketDataProvider } from "../../src/lib/market/provider";
import { isMarketClosed } from "../../src/lib/market/market-hours";
import { marketRateLimiter } from "../../src/lib/market/rate-limiter";
import {
  buildConditionContext,
  computeConditionMeta,
  conditionScore,
  CONDITION_GRANULARITY,
  CONDITION_LOOKBACK_DAYS,
  MAX_CONDITION_CANDLES,
} from "../../src/lib/market/condition-input";
import {
  alertCooldownActive,
  buildMarketAlert,
  ratingChangedToActionable,
} from "../../src/lib/market/condition-alerts";
import { DEFAULT_PREFS, type NotificationPrefs } from "../../src/server/lib/notification-types";

const prisma = new PrismaClient();

/** Phase 28: recompute + store the condition score for every pair this often. */
const CONDITION_JOB_INTERVAL_MS = 60 * 1000;
/** Phase 28: window the worker re-reads news + candles over each cycle. */
const CONDITION_NEWS_WINDOW_MS = 60 * 60 * 1000;

const DEFAULT_WATCHLIST = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "USD_CAD",
  "USD_CHF",
  "NZD_USD",
  "EUR_GBP",
  "EUR_JPY",
  "GBP_JPY",
];

const MAX_PAIRS = parseInt(process.env.MARKET_WATCHLIST_MAX_PAIRS || "20", 10);

async function ensureInstruments(provider: MarketDataProvider) {
  for (const symbol of DEFAULT_WATCHLIST.slice(0, MAX_PAIRS)) {
    const [base, quote] = symbol.split("_");
    await prisma.instrument.upsert({
      where: { symbol },
      update: { isActive: true },
      create: {
        symbol,
        base,
        quote,
        pipSize: symbol.includes("JPY") ? 0.01 : 0.0001,
        isActive: true,
        isMajor: true,
      },
    });
  }
}

async function updateStatus(provider: MarketDataProvider, error?: any) {
  const providerName = provider.name;
  if (error) {
    await prisma.marketDataStatus.upsert({
      where: { id: `status_${providerName}` },
      update: {
        lastErrorAt: new Date(),
        lastError: String(error?.message || error).slice(0, 500),
        provider: providerName,
      },
      create: {
        id: `status_${providerName}`,
        provider: providerName,
        lastErrorAt: new Date(),
        lastError: String(error?.message || error).slice(0, 500),
        requestsToday: 0,
      },
    });
  } else {
    await prisma.marketDataStatus.upsert({
      where: { id: `status_${providerName}` },
      update: {
        lastSuccessAt: new Date(),
        lastError: null,
        provider: providerName,
      },
      create: {
        id: `status_${providerName}`,
        provider: providerName,
        lastSuccessAt: new Date(),
        requestsToday: 0,
      },
    });
  }
}

async function backfill(provider: MarketDataProvider) {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  for (const inst of instruments) {
    for (const granularity of ["M5", "H1"]) {
      try {
        await marketRateLimiter.consume(provider.name);
        const candles = await provider.getCandles(inst.symbol, granularity, thirtyDaysAgo, now);
        let inserted = 0;
        for (const c of candles) {
          try {
            await prisma.candle.upsert({
              where: {
                instrumentId_granularity_time: {
                  instrumentId: inst.id,
                  granularity,
                  time: c.time,
                },
              },
              update: {},
              create: {
                instrumentId: inst.id,
                granularity,
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume ?? 0,
                bid: c.bid,
                ask: c.ask,
              },
            });
            inserted++;
          } catch (e) {
            // skip duplicate
          }
        }
        console.log(`Backfilled ${inst.symbol} ${granularity}: ${inserted} candles`);
        await updateStatus(provider);
      } catch (e: any) {
        console.error(`Backfill error for ${inst.symbol} ${granularity}:`, e?.message);
        await updateStatus(provider, e);
        // exponential backoff on error
        await new Promise((r) => setTimeout(r, Math.min(60000, 1000 * Math.pow(2, 1))));
      }
    }
  }
}

async function pollUpdates(provider: MarketDataProvider) {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  if (isMarketClosed(now)) {
    console.log("Market closed - skipping poll updates");
    return;
  }

  for (const inst of instruments) {
    for (const granularity of ["M1", "M5"]) {
      try {
        await marketRateLimiter.consume(provider.name);
        const candles = await provider.getCandles(inst.symbol, granularity, fiveMinAgo, now);
        for (const c of candles) {
          try {
            await prisma.candle.upsert({
              where: {
                instrumentId_granularity_time: {
                  instrumentId: inst.id,
                  granularity,
                  time: c.time,
                },
              },
              update: {},
              create: {
                instrumentId: inst.id,
                granularity,
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume ?? 0,
                bid: c.bid,
                ask: c.ask,
              },
            });
          } catch (e) {
            // ignore
          }
        }
        await updateStatus(provider);
      } catch (e: any) {
        if (e?.message?.includes("429")) {
          console.log("Rate limited, backing off...");
        }
        console.error(`Poll error for ${inst.symbol} ${granularity}:`, e?.message);
        await updateStatus(provider, e);
        await new Promise((r) =>
          setTimeout(r, Math.min(60000, 1000 * Math.pow(2, Math.floor(Math.random() * 4)))),
        );
      }
    }
  }
}

async function retentionCleanup() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const twoYearsAgo = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);

  await prisma.candle.deleteMany({ where: { granularity: "M1", time: { lt: sevenDaysAgo } } });
  await prisma.candle.deleteMany({ where: { granularity: "M5", time: { lt: ninetyDaysAgo } } });
  await prisma.candle.deleteMany({ where: { granularity: "H1", time: { lt: twoYearsAgo } } });
  await prisma.candle.deleteMany({ where: { granularity: "D", time: { lt: twoYearsAgo } } });
  console.log("Retention cleanup completed");
}

/**
 * Phase 28 — Compute the condition score for EVERY watchlist pair and store the
 * latest row in `MarketCondition`. Computed ONCE here and shared by all users
 * via the DB, so more users never means more provider calls (spec). This reads
 * candles already polled into the DB — zero extra provider calls.
 */
async function computeConditions() {
  const now = new Date();
  const marketClosed = isMarketClosed(now);

  // News: ONE shared fetch for the whole cycle (never per pair / per user).
  let newsRows: Array<{
    currency: string;
    title: string;
    impact: string;
    scheduledAt: Date;
  }> | null = null;
  try {
    const since = new Date(now.getTime() - CONDITION_NEWS_WINDOW_MS);
    const events = await prisma.newsEvent.findMany({
      where: { scheduledAt: { gte: since } },
      orderBy: { scheduledAt: "asc" },
      select: { currency: true, title: true, impact: true, scheduledAt: true },
    });
    newsRows = events;
  } catch (e: any) {
    // Feed unavailable → null = UNKNOWN. Never assume "no news" (rule #11).
    console.error("Condition job: news fetch failed, marking UNKNOWN:", e?.message);
    newsRows = null;
  }

  const instruments = await prisma.instrument.findMany({
    where: { isActive: true },
    select: { id: true, symbol: true },
  });
  const startedAt = Date.now();
  let scored = 0;

  for (const inst of instruments) {
    try {
      const since = new Date(now.getTime() - CONDITION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const candleRows = await prisma.candle.findMany({
        where: { instrumentId: inst.id, granularity: CONDITION_GRANULARITY, time: { gte: since } },
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

      const ctx = buildConditionContext({
        pair: inst.symbol,
        now,
        candleRows,
        lastSuccessAt: null,
        newsRows,
        marketClosed,
      });

      const result = conditionScore(ctx);
      const meta = computeConditionMeta(ctx, result.factors);

      // Read the previous row FIRST so we can detect a rating transition for
      // the favorite-pair alert before overwriting it.
      const previous = await prisma.marketCondition.findUnique({
        where: { instrumentId: inst.id },
        select: { rating: true },
      });

      await prisma.marketCondition.upsert({
        where: { instrumentId: inst.id },
        update: {
          score: result.score,
          rating: result.rating,
          factors: result.factors,
          reasons: result.reasons,
          meta,
          computedAt: now,
        },
        create: {
          instrumentId: inst.id,
          score: result.score,
          rating: result.rating,
          factors: result.factors,
          reasons: result.reasons,
          meta,
          computedAt: now,
        },
      });

      if (ratingChangedToActionable(previous?.rating, result.rating)) {
        await dispatchFavoriteAlerts(inst.id, inst.symbol, result.rating);
      }
      scored++;
    } catch (e: any) {
      console.error(`Condition job error for ${inst.symbol}:`, e?.message);
    }
  }

  // One shared computation for ALL users — no per-user / per-request provider
  // calls (Phase 28 acceptance: verify in logs).
  console.log(
    `[conditions] scored ${scored}/${instruments.length} pairs in ${Date.now() - startedAt}ms ` +
      `(shared across all users; news=${newsRows == null ? "UNKNOWN" : `${newsRows.length} rows`})`,
  );
}

/**
 * Phase 28 — Notify users who favor a pair whose rating just flipped to
 * GOOD/AVOID. Off by default (the `MARKET_CONDITION_CHANGED` in-app pref is
 * false in DEFAULT_PREFS); rate-limited to one alert per pair per 30 minutes via
 * `MarketFavorite.lastAlertAt`.
 */
async function dispatchFavoriteAlerts(instrumentId: string, symbol: string, rating: string) {
  if (rating !== "GOOD" && rating !== "AVOID") return;
  const now = new Date();

  const favorites = await prisma.marketFavorite.findMany({
    where: { instrumentId },
    select: {
      id: true,
      userId: true,
      lastAlertAt: true,
      user: { select: { notificationPrefs: true } },
    },
  });

  for (const fav of favorites) {
    const prefs = (fav.user?.notificationPrefs ?? {}) as NotificationPrefs;
    const pref = prefs.MARKET_CONDITION_CHANGED ?? DEFAULT_PREFS.MARKET_CONDITION_CHANGED;
    if (!pref?.inApp) continue; // off by default — user must opt in
    if (alertCooldownActive(fav.lastAlertAt, now)) continue; // 30-min limit

    const { title, body } = buildMarketAlert(rating as "GOOD" | "AVOID", symbol);
    try {
      await prisma.notification.create({
        data: { userId: fav.userId, type: "MARKET_CONDITION_CHANGED", title, body },
      });
      await prisma.marketFavorite.update({ where: { id: fav.id }, data: { lastAlertAt: now } });
    } catch (e: any) {
      console.error(`Favorite alert error (${symbol} → ${fav.userId}):`, e?.message);
    }
  }
}

async function main() {
  const provider = getMarketProvider();
  console.log(`Starting market data worker with provider: ${provider.name}`);
  await ensureInstruments(provider);
  await backfill(provider);
  setInterval(() => pollUpdates(provider), 60 * 1000); // poll every minute
  setInterval(() => retentionCleanup(), 24 * 60 * 60 * 1000); // daily
  // Phase 28 — score every pair every minute and store one shared row each.
  setInterval(() => void computeConditions(), CONDITION_JOB_INTERVAL_MS);
  void computeConditions();
}

main().catch((e) => {
  console.error("Worker crashed:", e);
  process.exit(1);
});
