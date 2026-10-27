"use server";

/**
 * Phase 11 — Export server actions (CSV + XLSX) for trades, transactions,
 * and report summaries. PROJECT_RULES.md rule #3: every query is scoped
 * by userId.
 */
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import * as XLSX from "xlsx";

const escapeCSV = (s: unknown) => {
  const str = String(s ?? "");
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
};

function toCSV(rows: Record<string, unknown>[], headers: string[]): string {
  const header = headers.join(",");
  const body = rows.map((r) => headers.map((h) => escapeCSV(r[h])).join(",")).join("\r\n");
  return `${header}\r\n${body}`;
}

function toXLSX(
  rows: Record<string, unknown>[],
  headers: string[],
  sheetName: string,
): ArrayBuffer {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── Trades export ──────────────────────────────────────────────────────

export async function exportTradesCSV(
  accountId?: string | null,
): Promise<{ csv: string; filename: string }> {
  const { userId } = await requireUser();
  const trades = await db.trade.findMany({
    where: { userId, ...(accountId ? { tradingAccountId: accountId } : {}) },
    orderBy: { openedAt: "desc" },
    select: {
      openedAt: true,
      closedAt: true,
      asset: true,
      direction: true,
      stake: true,
      payoutPercent: true,
      expiryMinutes: true,
      result: true,
      profitLoss: true,
      balanceAfter: true,
      timeframe: true,
      emotion: true,
      followedPlan: true,
      setupNotes: true,
      tags: true,
      tradingAccount: { select: { name: true } },
      strategy: { select: { name: true } },
    },
  });

  const headers = [
    "Date",
    "Account",
    "Asset",
    "Direction",
    "Stake",
    "Payout %",
    "Expiry (min)",
    "Result",
    "P/L",
    "Balance After",
    "Timeframe",
    "Strategy",
    "Emotion",
    "Followed Plan",
    "Notes",
    "Tags",
  ];
  const rows = trades.map((t) => ({
    Date: t.openedAt.toISOString(),
    Account: t.tradingAccount.name,
    Asset: t.asset,
    Direction: t.direction,
    Stake: t.stake.toString(),
    "Payout %": (Number(t.payoutPercent.toString()) * 100).toFixed(2) + "%",
    "Expiry (min)": t.expiryMinutes,
    Result: t.result,
    "P/L": t.profitLoss.toString(),
    "Balance After": t.balanceAfter?.toString() ?? "",
    Timeframe: t.timeframe ?? "",
    Strategy: t.strategy?.name ?? "",
    Emotion: t.emotion ?? "",
    "Followed Plan": t.followedPlan ? "Yes" : "No",
    Notes: t.setupNotes ?? "",
    Tags: Array.isArray(t.tags) ? (t.tags as string[]).join("; ") : "",
  }));
  return {
    csv: toCSV(rows, headers),
    filename: `riskguard-trades-${new Date().toISOString().slice(0, 10)}.csv`,
  };
}

export async function exportTradesXLSX(
  accountId?: string | null,
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const { userId } = await requireUser();
  const trades = await db.trade.findMany({
    where: { userId, ...(accountId ? { tradingAccountId: accountId } : {}) },
    orderBy: { openedAt: "desc" },
    select: {
      openedAt: true,
      asset: true,
      direction: true,
      stake: true,
      payoutPercent: true,
      result: true,
      profitLoss: true,
      tradingAccount: { select: { name: true } },
      strategy: { select: { name: true } },
    },
  });
  const headers = ["Date", "Account", "Asset", "Direction", "Stake", "Payout", "Result", "P/L"];
  const rows = trades.map((t) => ({
    Date: t.openedAt.toISOString(),
    Account: t.tradingAccount.name,
    Asset: t.asset,
    Direction: t.direction,
    Stake: Number(t.stake.toString()),
    Payout: Number(t.payoutPercent.toString()),
    Result: t.result,
    "P/L": Number(t.profitLoss.toString()),
  }));
  return {
    buffer: toXLSX(rows, headers, "Trades"),
    filename: `riskguard-trades-${new Date().toISOString().slice(0, 10)}.xlsx`,
  };
}

// ─── Transactions export ────────────────────────────────────────────────

export async function exportTransactionsCSV(
  accountId?: string | null,
): Promise<{ csv: string; filename: string }> {
  const { userId } = await requireUser();
  const txns = await db.transaction.findMany({
    where: { tradingAccount: { userId, ...(accountId ? { id: accountId } : {}) } },
    orderBy: { occurredAt: "desc" },
    select: {
      occurredAt: true,
      type: true,
      amount: true,
      note: true,
      tradingAccount: { select: { name: true, currency: true } },
    },
  });
  const headers = ["Date", "Account", "Type", "Amount", "Currency", "Note"];
  const rows = txns.map((t) => ({
    Date: t.occurredAt.toISOString(),
    Account: t.tradingAccount.name,
    Type: t.type,
    Amount: t.amount.toString(),
    Currency: t.tradingAccount.currency,
    Note: t.note ?? "",
  }));
  return {
    csv: toCSV(rows, headers),
    filename: `riskguard-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
  };
}
