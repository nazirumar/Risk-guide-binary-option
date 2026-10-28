import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";

export async function GET() {
  try {
    await requireUser();
    const instruments = await db.instrument.findMany({ where: { isActive: true } });
    return NextResponse.json({ instruments });
  } catch (e) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
