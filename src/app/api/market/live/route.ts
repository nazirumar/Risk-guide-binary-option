import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getMarketProvider } from "@/lib/market/provider";
import { isMarketClosed } from "@/lib/market/market-hours";
import {
  buildConditionContext,
  computeConditionMeta,
  conditionScore,
  CONDITION_GRANULARITY,
  CONDITION_LOOKBACK_DAYS,
  MAX_CONDITION_CANDLES,
} from "@/lib/market/condition-input";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type CacheEntry = { at: number; data: any };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

export async function GET() {
  const key = "market-live-v1";
  const now = new Date();
  const cached = cache.get(key);
  if (cached && now.getTime() - cached.at < TTL_MS) {
    return NextResponse.json(cached.data, {
      headers: {
        "Cache-Control": "s-maxage=30, stale-while-revalidate=60",
      },
    });
  }

  try {
    const provider = getMarketProvider();
    const marketClosed = isMarketClosed(now);

    let newsRows: any = null;
    try {
      const since = new Date(now.getTime() - 60 * 60 * 1000);
      newsRows = await db.newsEvent.findMany({
        where: { scheduledAt: { gte: since } },
        orderBy: { scheduledAt: "asc" },
        select: { currency: true, title: true, impact: true, scheduledAt: true },
      });
    } catch {
      newsRows = null;
    }

    const instruments = await db.instrument.findMany({
      where: { isActive: true },
      include: { hourlyStats: { select: { sampleDays: true } } },
    });

    const pairs: any[] = [];

    for (const inst of instruments) {
      try {
        const from = new Date(now.getTime() - CONDITION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        let candleRows = await db.candle.findMany({
          where: { instrumentId: inst.id, granularity: CONDITION_GRANULARITY, time: { gte: from } },
          orderBy: { time: "asc" },
          take: MAX_CONDITION_CANDLES,
          select: { time: true, open: true, high: true, low: true, close: true, volume: true, bid: true, ask: true },
        });

        let lastSuccessAt: Date | null = null;

        if (candleRows.length < 50) {
          try {
            const candles = await provider.getCandles(inst.symbol, CONDITION_GRANULARITY, from, now);
            if (candles.length > 0) {
              candleRows = candles.map((c) => ({
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume ?? 0,
                bid: c.bid,
                ask: c.ask,
              }));
              lastSuccessAt = new Date();
            }
          } catch {}
        }

        const newest = candleRows.length > 0 ? candleRows[candleRows.length - 1].time : null;
        if (!newest || now.getTime() - newest.getTime() > 180000) {
          try {
            const candles = await provider.getCandles(inst.symbol, CONDITION_GRANULARITY, new Date(now.getTime() - 2 * 60 * 60 * 1000), now);
            if (candles.length > 0) {
              candleRows = candles.map((c) => ({
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume ?? 0,
                bid: c.bid,
                ask: c.ask,
              }));
              lastSuccessAt = new Date();
            }
          } catch {}
        }

        try {
          const hasSpread = candleRows.some((c: any) => c.bid != null && c.ask != null);
          if (!hasSpread && candleRows.length > 0) {
            const last: any = candleRows[candleRows.length - 1];
            const close = Number(last.close);
            if (Number.isFinite(close) && close > 0) {
              const pip = inst.symbol.includes("JPY") ? 0.01 : 0.0001;
              const spreadPips = 1.5;
              last.bid = close - (spreadPips * pip) / 2;
              last.ask = close + (spreadPips * pip) / 2;
              for (const c of candleRows) {
                if ((c as any).bid == null || (c as any).ask == null) {
                  const cc = Number((c as any).close);
                  if (Number.isFinite(cc)) {
                    (c as any).bid = cc - (spreadPips * pip) / 2;
                    (c as any).ask = cc + (spreadPips * pip) / 2;
                  }
                }
              }
              lastSuccessAt = new Date();
            }
          }
        } catch {}

        const ctx = buildConditionContext({
          pair: inst.symbol,
          now,
          candleRows,
          lastSuccessAt,
          newsRows,
          marketClosed,
        });
        const result = conditionScore(ctx);
        const meta = computeConditionMeta(ctx, result.factors);

        const rating = result.rating === "GOOD" || result.rating === "AVOID" ? result.rating : "CAUTION";
        const maxSampleDays = inst.hourlyStats.reduce((m: number, s: any) => Math.max(m, s.sampleDays), 0);

        pairs.push({
          instrumentId: inst.id,
          symbol: inst.symbol,
          displayName: inst.symbol.replace("_", "/"),
          score: result.score,
          rating,
          factors: result.factors,
          reasons: result.reasons,
          computedAt: now.toISOString(),
          ageSeconds: 0,
          session: (meta as any)?.session ?? null,
          spread: (meta as any)?.currentSpread ?? null,
          typicalSpread: (meta as any)?.typicalSpread ?? null,
          spreadRatio: (meta as any)?.spreadRatio ?? null,
          volatilityPercentile: (meta as any)?.volatilityPercentile ?? null,
          marketClosed,
          nextNewsTitle: (meta as any)?.nextNewsTitle ?? null,
          nextNewsMinutesTo: (meta as any)?.nextNewsMinutesTo ?? null,
          newsKnown: (meta as any)?.newsKnown ?? false,
          heatmapReady: maxSampleDays >= 10,
        });
      } catch {}
    }

    pairs.sort((a, b) => b.score - a.score);

    const data = {
      serverTime: now.toISOString(),
      isStale: pairs.length === 0,
      dataAgeSeconds: pairs.length > 0 ? 0 : null,
      provider: provider.name,
      providerLagSeconds: 0,
      providerLastError: null,
      marketClosed,
      pairs,
      nextNews: null,
    };

    cache.set(key, { at: now.getTime(), data });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { serverTime: now.toISOString(), isStale: true, dataAgeSeconds: null, provider: null, providerLagSeconds: null, providerLastError: e?.message, marketClosed: false, pairs: [], nextNews: null },
      { status: 200 }
    );
  }
}
