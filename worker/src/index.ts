import { PrismaClient } from "@prisma/client";
import { getMarketProvider, MarketDataProvider } from "../../src/lib/market/provider";
import { isMarketClosed } from "../../src/lib/market/market-hours";
import { marketRateLimiter } from "../../src/lib/market/rate-limiter";

const prisma = new PrismaClient();

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

async function main() {
  const provider = getMarketProvider();
  console.log(`Starting market data worker with provider: ${provider.name}`);
  await ensureInstruments(provider);
  await backfill(provider);
  setInterval(() => pollUpdates(provider), 60 * 1000); // poll every minute
  setInterval(() => retentionCleanup(), 24 * 60 * 60 * 1000); // daily
}

main().catch((e) => {
  console.error("Worker crashed:", e);
  process.exit(1);
});
