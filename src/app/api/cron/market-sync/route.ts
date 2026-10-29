import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { getMarketProvider } from "@/lib/market/provider";
import { marketRateLimiter } from "@/lib/market/rate-limiter";
import { isMarketClosed } from "@/lib/market/market-hours";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const provider = getMarketProvider();
    const maxPairs = parseInt(process.env.MARKET_WATCHLIST_MAX_PAIRS || "20", 10);

    for (const symbol of DEFAULT_WATCHLIST.slice(0, maxPairs)) {
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

    const now = new Date();
    if (isMarketClosed(now)) {
      return NextResponse.json({ ok: true, marketClosed: true });
    }

    const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

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
            } catch {}
          }
        } catch {}
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
