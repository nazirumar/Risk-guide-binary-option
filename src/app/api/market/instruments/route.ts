import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
  return NextResponse.json({ instruments });
}
