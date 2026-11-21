/**
 * GET /api/cron/news-briefing — token-protected scheduled news digest.
 *
 * Phase 30.4. Recommended schedule: once each morning (e.g. 07:00 UTC).
 * Composes one short, descriptive briefing per opted-in user from precomputed
 * news/market rows and the user's own journal aggregates, then dispatches via
 * the in-app / email / Telegram channels the user enabled. Everything is OFF
 * by default (DEFAULT_PREFS.NEWS_BRIEFING).
 *
 * Auth + response shape match the other cron routes (CRON_SECRET as a Bearer
 * header or ?token= query param).
 */
import { NextResponse } from "next/server";
import { sendNewsBriefings } from "@/server/lib/news-briefing";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

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
    const result = await sendNewsBriefings();
    return new NextResponse(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new NextResponse(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : "Cron failed.",
        ranAt: new Date().toISOString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
