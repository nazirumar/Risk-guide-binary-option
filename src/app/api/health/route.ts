import { NextResponse } from "next/server";

/**
 * GET /api/health — health check endpoint for uptime monitoring + load balancer.
 *
 * Returns 200 with a JSON body if the server is alive + the database is
 * reachable. Returns 503 if the DB is unreachable.
 *
 * No auth required — this is a public health check.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Check DB connectivity by counting users (cheap query).
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    await prisma.user.count({ take: 1 });
    await prisma.$disconnect();

    return NextResponse.json(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "riskguard",
        version: process.env.npm_package_version ?? "0.1.0",
      },
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      {
        status: "degraded",
        error: e instanceof Error ? e.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
