import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const prisma = new PrismaClient();

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
  try {
    const authHeader = req.headers.get("authorization");
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
    const now = new Date();
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    let total = 0;
    for (const inst of instruments) {
      try {
        const candles = await prisma.candle.findMany({
          where: { instrumentId: inst.id, granularity: "M5", time: { gte: from } },
          orderBy: { time: "asc" },
          select: { time: true, high: true, low: true, close: true },
        });
        if (candles.length < 100) continue;

        type Bucket = { days: Set<string>; values: number[] };
        const buckets = new Map<string, Bucket>();
        for (let i = 14; i < candles.length; i++) {
          const c = candles[i];
          const t = c.time;
          const weekday = t.getUTCDay();
          const hour = t.getUTCHours();
          const key = `${weekday}:${hour}`;
          if (!buckets.has(key)) buckets.set(key, { days: new Set(), values: [] });
          const b = buckets.get(key)!;
          const window = candles.slice(i - 14, i + 1);
          const a = atrPercent(window);
          if (a > 0) {
            b.values.push(a);
            b.days.add(t.toISOString().slice(0, 10));
          }
        }

        for (const [key, b] of buckets.entries()) {
          const [w, h] = key.split(":");
          const weekday = parseInt(w);
          const hourUtc = parseInt(h);
          if (b.days.size < 10 || b.values.length === 0) continue;
          const sorted = [...b.values].sort((x, y) => x - y);
          const avg = sorted.reduce((a, v) => a + v, 0) / sorted.length;
          const p20 = sorted[Math.floor(sorted.length * 0.2)] ?? avg;
          const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? avg;
          const p80 = sorted[Math.floor(sorted.length * 0.8)] ?? avg;
          await prisma.hourlyVolatilityStat.upsert({
            where: { instrumentId_weekday_hourUtc: { instrumentId: inst.id, weekday, hourUtc } },
            update: { avgAtrPercent: avg, p20, p50, p80, sampleDays: b.days.size },
            create: { instrumentId: inst.id, weekday, hourUtc, avgAtrPercent: avg, p20, p50, p80, sampleDays: b.days.size },
          });
          total++;
        }
      } catch {}
    }

    return NextResponse.json({ ok: true, upserted: total });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
