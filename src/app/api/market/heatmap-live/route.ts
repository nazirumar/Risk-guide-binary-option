import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type CacheEntry = { at: number; data: any };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 300_000;

function atrPercent(candles: Array<{ high: number; low: number; close: number }>): number {
  if (candles.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    sum += tr;
  }
  const atr = sum / (candles.length - 1);
  const lastClose = candles[candles.length - 1].close;
  if (lastClose <= 0) return 0;
  return (atr / lastClose) * 100;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "EUR_USD";
  const key = `heatmap-${pair}`;
  const now = new Date();
  const cached = cache.get(key);
  if (cached && now.getTime() - cached.at < TTL_MS) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "s-maxage=300" } });
  }

  try {
    const inst = await db.instrument.findFirst({ where: { symbol: pair, isActive: true } });
    if (!inst) {
      return NextResponse.json({ ok: false, cells: [] });
    }

    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const candles = await db.candle.findMany({
      where: { instrumentId: inst.id, granularity: "M5", time: { gte: from } },
      orderBy: { time: "asc" },
      select: { time: true, high: true, low: true, close: true },
    });

    if (candles.length < 100) {
      return NextResponse.json({ ok: true, pair, cells: [], insufficient: true });
    }

    type Bucket = { days: Set<string>; values: number[] };
    const buckets = new Map<string, Bucket>();
    for (let i = 14; i < candles.length; i++) {
      const c = candles[i];
      const t = c.time;
      const weekday = t.getUTCDay();
      const hour = t.getUTCHours();
      const keyB = `${weekday}:${hour}`;
      if (!buckets.has(keyB)) buckets.set(keyB, { days: new Set(), values: [] });
      const b = buckets.get(keyB)!;
      const window = candles.slice(i - 14, i + 1);
      const a = atrPercent(window);
      if (a > 0) {
        b.values.push(a);
        b.days.add(t.toISOString().slice(0, 10));
      }
    }

    const cells: any[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      for (let hour = 0; hour < 24; hour++) {
        const keyB = `${weekday}:${hour}`;
        const b = buckets.get(keyB);
        if (!b || b.days.size < 10 || b.values.length === 0) {
          cells.push({ weekday, hourUtc: hour, avgAtrPercent: null, sampleDays: b?.days.size ?? 0 });
        } else {
          const sorted = [...b.values].sort((x, y) => x - y);
          const avg = sorted.reduce((a, v) => a + v, 0) / sorted.length;
          cells.push({ weekday, hourUtc: hour, avgAtrPercent: avg, sampleDays: b.days.size });
        }
      }
    }

    const data = { ok: true, pair, cells, computedAt: now.toISOString() };
    cache.set(key, { at: now.getTime(), data });
    return NextResponse.json(data, { headers: { "Cache-Control": "s-maxage=300" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message, cells: [] });
  }
}
