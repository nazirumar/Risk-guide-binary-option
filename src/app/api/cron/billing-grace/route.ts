import { NextResponse } from "next/server";
import { expireGracePeriodsAction } from "@/server/actions/billing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const provided = authHeader === `Bearer ${expected}` || token === expected;
    if (!provided)
      return new NextResponse(JSON.stringify({ error: "Unauthorized." }), { status: 401 });
  }
  try {
    const res = await expireGracePeriodsAction();
    return new NextResponse(
      JSON.stringify({ ok: true, expiredCount: res.expiredCount, ranAt: new Date().toISOString() }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    return new NextResponse(
      JSON.stringify({ error: e instanceof Error ? e.message : "Cron failed." }),
      { status: 500 },
    );
  }
}
