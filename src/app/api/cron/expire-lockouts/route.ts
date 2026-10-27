/**
 * GET /api/cron/expire-lockouts — token-protected cron endpoint.
 *
 * Use with Vercel Cron (set the `CRON_SECRET` env var and a cron.yaml):
 *   ```yaml
 *   # vercel.json
 *   crons:
 *     - path: "/api/cron/expire-lockouts"
 *       schedule: "0 * * * *"  # hourly
 *   ```
 *
 * Or with node-cron:
 *   ```ts
 *   import cron from "node-cron";
 *   import { expireOldLockouts } from "@/server/actions/lockout";
 *   cron.schedule("0 * * * *", () => expireOldLockouts());
 *   ```
 *
 * Note: lockouts are *effectively* expired automatically when
 * `evaluateRisk()` checks `expiresAt < now` — this endpoint just deletes
 * the historical rows so the lockout table doesn't grow unbounded. Override
 * entries are kept until 7 days after their original expiry, so reports
 * (Phase 11) can still surface "you overrode X lockouts last month."
 */
import { NextResponse } from "next/server";
import { expireOldLockouts } from "@/server/actions/lockout";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  // Token-protect: either Vercel Cron's CRON_SECRET header, or a manual
  // secret in the query string.
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const expected = process.env.CRON_SECRET;

  // If CRON_SECRET isn't set in env, allow without auth (dev convenience —
  // prod MUST set CRON_SECRET).
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
    const deletedCount = await expireOldLockouts();
    return new NextResponse(
      JSON.stringify({ ok: true, deletedCount, ranAt: new Date().toISOString() }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new NextResponse(
      JSON.stringify({ error: e instanceof Error ? e.message : "Cron failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
