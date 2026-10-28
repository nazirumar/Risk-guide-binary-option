/**
 * GET /api/cron/hourly-volatility — token-protected nightly cron endpoint.
 *
 * Recomputes the `HourlyVolatilityStat` heatmap rows for every active
 * instrument from stored M5 candles. Idempotent — safe to re-run.
 *
 * Use with Vercel Cron (set the `CRON_SECRET` env var):
 *   ```yaml
 *   # vercel.json
 *   crons:
 *     - path: "/api/cron/hourly-volatility"
 *       schedule: "0 2 * * *"  # daily at 02:00 UTC (after the NY session closes)
 *   ```
 *
 * Or with node-cron:
 *   ```ts
 *   import cron from "node-cron";
 *   import { recomputeHourlyVolatilityAction } from "@/server/actions/market-conditions";
 *   cron.schedule("0 2 * * *", () => recomputeHourlyVolatilityAction());
 *   ```
 *
 * Token check mirrors /api/cron/discipline-scores — if CRON_SECRET is unset
 * the call is allowed (dev convenience); prod MUST set the secret.
 */
import { NextResponse } from "next/server";
import { recomputeHourlyVolatilityAction } from "@/server/actions/market-conditions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const expected = process.env.CRON_SECRET;

  if (expected) {
    const provided = authHeader === `Bearer ${expected}` || token === expected;
    if (!provided) {
      return new NextResponse(JSON.stringify({ error: "Unauthorized." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  try {
    const res = await recomputeHourlyVolatilityAction();
    return new NextResponse(
      JSON.stringify({
        ok: true,
        instrumentsProcessed: res.instrumentsProcessed,
        cellsWritten: res.cellsWritten,
        ranAt: new Date().toISOString(),
        message: res.message,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new NextResponse(
      JSON.stringify({ error: e instanceof Error ? e.message : "Cron failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
