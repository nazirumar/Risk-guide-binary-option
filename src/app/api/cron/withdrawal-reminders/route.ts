/**
 * GET /api/cron/withdrawal-reminders — token-protected cron endpoint.
 *
 * Use with Vercel Cron (set the `CRON_SECRET` env var):
 *   ```yaml
 *   # vercel.json
 *   crons:
 *     - path: "/api/cron/withdrawal-reminders"
 *       schedule: "0 9 * * *"  # daily at 09:00 UTC
 *   ```
 *
 * Or with node-cron:
 *   ```ts
 *   import cron from "node-cron";
 *   import { sendWithdrawalRemindersAction } from "@/server/actions/withdrawals";
 *   cron.schedule("0 9 * * *", () => sendWithdrawalRemindersAction());
 *   ```
 *
 * The endpoint runs `sendWithdrawalRemindersAction`, which scans all active
 * rules across all users and fires a WITHDRAWAL_DUE notification (in-app +
 * email per the user's prefs) for each rule that is due per its frequency
 * AND has profit to withdraw.
 *
 * Notes:
 *   - The action does NOT require `requireUser()` — it's a system-level sweep.
 *   - Token-protected exactly like /api/cron/expire-lockouts. If CRON_SECRET
 *     is unset, the endpoint allows the call (dev convenience) — prod MUST
 *     set the secret.
 */
import { NextResponse } from "next/server";
import { sendWithdrawalRemindersAction } from "@/server/actions/withdrawals";

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
    const res = await sendWithdrawalRemindersAction();
    return new NextResponse(
      JSON.stringify({
        ok: true,
        scannedCount: res.scannedCount,
        firedCount: res.firedCount,
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
