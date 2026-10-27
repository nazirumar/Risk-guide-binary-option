/**
 * GET /api/cron/telegram-daily-summary — token-protected cron endpoint.
 *
 * Runs every 15 minutes; sends the daily summary to users whose chosen
 * `telegramDailySummaryTime` falls within the current 15-minute bucket
 * (in each user's TZ).
 *
 * Recommended Vercel Cron schedule: every 15 minutes.
 * (`schedule: "0/15 * * * *"` in vercel.json crons.)
 */
import { NextResponse } from "next/server";
import { sendDailySummariesAction } from "@/server/actions/telegram";

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
    const res = await sendDailySummariesAction();
    return new NextResponse(
      JSON.stringify({
        ok: true,
        sentCount: res.sentCount,
        scannedCount: res.scannedCount,
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
