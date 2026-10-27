/**
 * GET /api/cron/discipline-scores — token-protected cron endpoint.
 *
 * Use with Vercel Cron (set the `CRON_SECRET` env var):
 *   ```yaml
 *   # vercel.json
 *   crons:
 *     - path: "/api/cron/discipline-scores"
 *       schedule: "0 1 * * *"  # daily at 01:00 UTC (after most TZs have rolled over)
 *   ```
 *
 * Or with node-cron:
 *   ```ts
 *   import cron from "node-cron";
 *   import { sendDailyScoresSweepAction } from "@/server/actions/discipline";
 *   cron.schedule("0 1 * * *", () => sendDailyScoresSweepAction());
 *   ```
 *
 * The endpoint runs `sendDailyScoresSweepAction`, which recomputes yesterday's
 * score for every onboarded user (in each user's TZ). DailyScore rows are
 * upserted — safe to call repeatedly.
 *
 * Notes:
 *   - The action does NOT require `requireUser()` — it's a system-level sweep.
 *   - Token-protected exactly like /api/cron/expire-lockouts +
 *     /api/cron/withdrawal-reminders. If CRON_SECRET is unset, the endpoint
 *     allows the call (dev convenience) — prod MUST set the secret.
 */
import { NextResponse } from "next/server";
import { sendDailyScoresSweepAction } from "@/server/actions/discipline";

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
    const res = await sendDailyScoresSweepAction();
    return new NextResponse(
      JSON.stringify({
        ok: true,
        scannedCount: res.scannedCount,
        computedCount: res.computedCount,
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
