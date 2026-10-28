import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const status = await prisma.marketDataStatus.findMany();
  return NextResponse.json({ status });
}
