/**
 * GET /api/cron/refresh-news — token-protected cron endpoint.
 *
 * Use with Vercel Cron (recommended schedule: every 6 hours — events
 * change as the day rolls; the path is "/api/cron/refresh-news").
 *
 * Calls `refreshNewsEventsAction` to fetch the next 24h of events from
 * the configured provider (see /src/lib/news/provider.ts). Provider
 * failures are caught gracefully — the response returns 200 with a
 * `providerError` field so the cron dashboard can flag it; the cached
 * NewsEvent rows stay intact for the UI to display with a notice.
 *
 * Token-protected exactly like /api/cron/expire-lockouts +
 * /api/cron/withdrawal-reminders + /api/cron/discipline-scores.
 */
import { NextResponse } from "next/server";
import { refreshNewsEventsAction } from "@/server/actions/news";

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
    const res = await refreshNewsEventsAction();
    const ok = res.ok;
    return new NextResponse(
      JSON.stringify({
        ok,
        refreshedCount: res.refreshedCount,
        providerName: res.providerName,
        ranAt: new Date().toISOString(),
        message: res.message,
        // When the provider failed, we still return 200 so the cron
        // dashboard doesn't retry — the cached data is intact + the UI
        // surfaces the notice. The `ok=false` flag tells the operator.
        providerError: ok ? null : res.message,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    // Hard crash — return 500 so the cron operator can investigate.
    return new NextResponse(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Cron failed.",
        ok: false,
        ranAt: new Date().toISOString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
