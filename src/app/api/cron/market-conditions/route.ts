import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
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
export const maxDuration = 300;

const prisma = new PrismaClient();
const CONDITION_NEWS_WINDOW_MS = 60 * 60 * 1000;

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const marketClosed = isMarketClosed(now);

    let newsRows: any = null;
    try {
      const since = new Date(now.getTime() - CONDITION_NEWS_WINDOW_MS);
      newsRows = await prisma.newsEvent.findMany({
        where: { scheduledAt: { gte: since } },
        orderBy: { scheduledAt: "asc" },
        select: { currency: true, title: true, impact: true, scheduledAt: true },
      });
    } catch {
      newsRows = null;
    }

    const instruments = await prisma.instrument.findMany({
      where: { isActive: true },
      select: { id: true, symbol: true },
    });

    let scored = 0;
    for (const inst of instruments) {
      try {
        const since = new Date(now.getTime() - CONDITION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        const candleRows = await prisma.candle.findMany({
          where: { instrumentId: inst.id, granularity: CONDITION_GRANULARITY, time: { gte: since } },
          orderBy: { time: "asc" },
          take: MAX_CONDITION_CANDLES,
          select: { time: true, open: true, high: true, low: true, close: true, volume: true, bid: true, ask: true },
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

        await prisma.marketCondition.upsert({
          where: { instrumentId: inst.id },
          update: { score: result.score, rating: result.rating, factors: result.factors, reasons: result.reasons, meta, computedAt: now },
          create: { instrumentId: inst.id, score: result.score, rating: result.rating, factors: result.factors, reasons: result.reasons, meta, computedAt: now },
        });
        scored++;
      } catch {}
    }

    return NextResponse.json({ ok: true, scored });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
