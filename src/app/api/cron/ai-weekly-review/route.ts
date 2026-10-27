/**
 * GET /api/cron/ai-weekly-review — token-protected cron endpoint.
 *
 * Runs weekly (recommended: Monday 02:00 UTC — shortly after the previous
 * week closes in all timezones). Generates the AI (or fallback) review for
 * every user with `aiReviewEnabled=true`, covering the PREVIOUS completed
 * week.
 *
 * Only aggregated stats are sent to the AI (no email/name/screenshots) —
 * enforced by the pure prompt builder + a unit test.
 */
import { NextResponse } from "next/server";
import { generateAllWeeklyReviewsAction } from "@/server/actions/ai-review";

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
    const res = await generateAllWeeklyReviewsAction();
    return new NextResponse(
      JSON.stringify({
        ok: true,
        generatedCount: res.generatedCount,
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
