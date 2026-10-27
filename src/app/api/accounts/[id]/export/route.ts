import { NextResponse } from "next/server";
import { exportTransactionsCSVAction } from "@/server/actions/transactions";

/**
 * GET /api/accounts/[id]/export → CSV download of the account's transactions.
 * Server action handles auth (requireUser) + ownership check.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await exportTransactionsCSVAction(id);
  if (!result.ok || !result.csv || !result.filename) {
    return new NextResponse(result.message ?? "Export failed", { status: 404 });
  }
  return new NextResponse(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
