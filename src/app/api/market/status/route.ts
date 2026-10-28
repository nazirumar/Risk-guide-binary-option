import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";

export async function GET() {
  try {
    await requireUser();

    const [status, candleCounts] = await Promise.all([
      db.marketDataStatus.findMany(),
      db.candle.groupBy({ by: ["granularity"], _count: { _all: true } }),
    ]);

    const now = Date.now();
    const enhanced = status.map((s) => ({
      ...s,
      lagSeconds: s.lastSuccessAt ? Math.floor((now - s.lastSuccessAt.getTime()) / 1000) : null,
    }));

    return NextResponse.json({
      status: enhanced,
      candleCounts: candleCounts.map((c) => ({ granularity: c.granularity, count: c._count._all })),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
