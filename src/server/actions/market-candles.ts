"use server";

/**
 * Phase 28 — M5 candles for the pair-detail drawer's mini chart.
 *
 * (rule #3: candles are global market data — no userId — but the action is only
 * called from the authed drawer. rule #4: Zod-validated input.)
 */
import { z } from "zod";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";

const QuerySchema = z.object({
  symbol: z.string().min(1).max(32),
  limit: z.number().int().min(20).max(500).default(200),
});

export type PairCandle = { time: number; open: number; high: number; low: number; close: number };

/** Latest M5 candles (ascending) for a pair symbol like "EUR_USD". */
export async function getPairCandlesAction(input: {
  symbol: string;
  limit?: number;
}): Promise<PairCandle[]> {
  const parsed = QuerySchema.safeParse({ limit: 200, ...input });
  if (!parsed.success) throw new Error("Invalid request");
  const { symbol, limit } = parsed.data;

  await requireUser();

  const instrument = await db.instrument.findUnique({
    where: { symbol },
    select: { id: true },
  });
  if (!instrument) return [];

  const rows = await db.candle.findMany({
    where: { instrumentId: instrument.id, granularity: "M5" },
    orderBy: { time: "desc" },
    take: limit,
    select: { time: true, open: true, high: true, low: true, close: true },
  });

  return rows
    .map((r) => ({
      time: r.time.getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    }))
    .reverse(); // ascending for the chart
}
