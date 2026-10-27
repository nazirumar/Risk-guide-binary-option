"use server";

/**
 * Phase 11 — CSV import wizard server actions.
 *
 * Flow:
 *   1. parseCSVAction: accept raw CSV text, return headers + preview rows
 *   2. importTradesAction: accept mapped columns + accountId, validate with
 *      Zod, skip duplicates (asset + openedAt), import in a transaction with
 *      balance recompute via recomputeAccountBalanceInTx.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { computeTradeProfitLoss } from "@/lib/calc/trade";
import { z } from "zod";

export type ParseResult = {
  ok: boolean;
  headers?: string[];
  preview?: Record<string, string>[];
  totalRows?: number;
  message?: string;
};

/** Parse CSV text into headers + preview rows (first 5). */
export async function parseCSVAction(formData: FormData): Promise<ParseResult> {
  await requireUser();
  const raw = String(formData.get("csv") ?? "");
  if (!raw.trim()) return { ok: false, message: "CSV content is empty." };

  try {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { ok: false, message: "CSV needs at least a header + 1 row." };

    // Simple CSV parser (handles quoted fields with commas).
    const parseLine = (line: string): string[] => {
      const fields: string[] = [];
      let field = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') {
            field += '"';
            i++;
          } else if (ch === '"') inQuotes = false;
          else field += ch;
        } else {
          if (ch === '"') inQuotes = true;
          else if (ch === ",") {
            fields.push(field);
            field = "";
          } else field += ch;
        }
      }
      fields.push(field);
      return fields.map((f) => f.trim());
    };

    const headers = parseLine(lines[0]);
    const dataRows = lines.slice(1).map((line) => {
      const values = parseLine(line);
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = values[i] ?? "";
      });
      return obj;
    });

    return {
      ok: true,
      headers,
      preview: dataRows.slice(0, 5),
      totalRows: dataRows.length,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Parse failed." };
  }
}

const importRowSchema = z.object({
  asset: z.string().min(1),
  direction: z.enum(["CALL", "PUT"]),
  stake: z.number().positive(),
  payoutPercent: z.number().min(0).max(1),
  expiryMinutes: z.number().int().min(1).max(1440),
  openedAt: z
    .string()
    .datetime()
    .or(z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "Invalid date")),
  result: z.enum(["WIN", "LOSS", "TIE", "OPEN"]),
  emotion: z.string().optional(),
  followedPlan: z.boolean().optional(),
  notes: z.string().optional(),
});

export type ImportResult = {
  ok: boolean;
  imported: number;
  duplicates: number;
  errors: { row: number; message: string }[];
  message: string;
  newBalance?: string;
};

export async function importTradesAction(formData: FormData): Promise<ImportResult> {
  const { userId } = await requireUser();
  const accountId = String(formData.get("tradingAccountId") ?? "");
  const columnMapRaw = String(formData.get("columnMap") ?? "{}");

  if (!accountId)
    return { ok: false, imported: 0, duplicates: 0, errors: [], message: "Account required." };

  // Verify account ownership.
  const account = await db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true, currentBalance: true },
  });
  if (!account)
    return { ok: false, imported: 0, duplicates: 0, errors: [], message: "Account not found." };

  let columnMap: Record<string, string>;
  try {
    columnMap = JSON.parse(columnMapRaw);
  } catch {
    return { ok: false, imported: 0, duplicates: 0, errors: [], message: "Invalid column map." };
  }

  const raw = String(formData.get("csv") ?? "");
  if (!raw.trim())
    return { ok: false, imported: 0, duplicates: 0, errors: [], message: "CSV content is empty." };

  // Parse CSV.
  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') inQuotes = false;
        else field += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ",") {
          fields.push(field);
          field = "";
        } else field += ch;
      }
    }
    fields.push(field);
    return fields.map((f) => f.trim());
  };

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2)
    return {
      ok: false,
      imported: 0,
      duplicates: 0,
      errors: [],
      message: "CSV needs at least a header + 1 row.",
    };

  const headers = parseLine(lines[0]);
  const dataRows = lines.slice(1).map((line) => {
    const values = parseLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] ?? "";
    });
    return obj;
  });

  // Fetch existing trades for dedup (asset + openedAt within same minute).
  const existingTrades = await db.trade.findMany({
    where: { userId, tradingAccountId: accountId },
    select: { asset: true, openedAt: true },
  });
  const existingKeys = new Set(existingTrades.map((t) => `${t.asset}-${t.openedAt.getTime()}`));

  const errors: { row: number; message: string }[] = [];
  let imported = 0;
  let duplicates = 0;
  const tradesToCreate: Array<{
    userId: string;
    tradingAccountId: string;
    asset: string;
    direction: "CALL" | "PUT";
    stake: Decimal;
    payoutPercent: Decimal;
    expiryMinutes: number;
    openedAt: Date;
    closedAt: Date | null;
    result: "WIN" | "LOSS" | "TIE" | "OPEN";
    profitLoss: Decimal;
    emotion: string | null;
    followedPlan: boolean;
    setupNotes: string | null;
  }> = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2; // 1-indexed + header

    // Map columns.
    const mapped = {
      asset: row[columnMap.asset ?? ""] ?? "",
      direction: (row[columnMap.direction ?? ""] ?? "CALL").toUpperCase() as "CALL" | "PUT",
      stake: Number(row[columnMap.stake ?? ""] ?? "0"),
      payoutPercent: Number(row[columnMap.payoutPercent ?? ""] ?? "0"),
      expiryMinutes: Number(row[columnMap.expiryMinutes ?? ""] ?? "5"),
      openedAt: row[columnMap.openedAt ?? ""] ?? "",
      result: (row[columnMap.result ?? ""] ?? "OPEN").toUpperCase() as
        "WIN" | "LOSS" | "TIE" | "OPEN",
      emotion: row[columnMap.emotion ?? ""] ?? undefined,
      followedPlan: (row[columnMap.followedPlan ?? ""] ?? "Yes").toLowerCase().startsWith("y"),
      notes: row[columnMap.notes ?? ""] ?? undefined,
    };

    // Handle payout as percentage vs fraction.
    if (mapped.payoutPercent > 1) mapped.payoutPercent = mapped.payoutPercent / 100;

    const parsed = importRowSchema.safeParse(mapped);
    if (!parsed.success) {
      errors.push({ row: rowNum, message: parsed.error.issues[0]?.message ?? "Invalid row." });
      continue;
    }

    const openedAt = new Date(parsed.data.openedAt);
    if (Number.isNaN(openedAt.getTime())) {
      errors.push({ row: rowNum, message: "Invalid date." });
      continue;
    }

    // Dedup check.
    const key = `${parsed.data.asset}-${openedAt.getTime()}`;
    if (existingKeys.has(key)) {
      duplicates++;
      continue;
    }
    existingKeys.add(key);

    // Compute P/L.
    const stake = new Decimal(parsed.data.stake).toDecimalPlaces(2);
    const payout = new Decimal(parsed.data.payoutPercent).toDecimalPlaces(4);
    const profitLoss = computeTradeProfitLoss(stake, payout, parsed.data.result).toDecimalPlaces(2);
    const closedAt =
      parsed.data.result !== "OPEN"
        ? new Date(openedAt.getTime() + parsed.data.expiryMinutes * 60 * 1000)
        : null;

    tradesToCreate.push({
      userId,
      tradingAccountId: accountId,
      asset: parsed.data.asset,
      direction: parsed.data.direction,
      stake,
      payoutPercent: payout,
      expiryMinutes: parsed.data.expiryMinutes,
      openedAt,
      closedAt,
      result: parsed.data.result,
      profitLoss,
      emotion: parsed.data.emotion ?? null,
      followedPlan: parsed.data.followedPlan ?? true,
      setupNotes: parsed.data.notes ?? null,
    });
    imported++;
  }

  // Import in a transaction with balance recompute.
  let newBalance = "";
  if (tradesToCreate.length > 0) {
    const result = await db.$transaction(async (tx) => {
      // Create trades in chunks.
      const chunkSize = 50;
      for (let i = 0; i < tradesToCreate.length; i += chunkSize) {
        await tx.trade.createMany({ data: tradesToCreate.slice(i, i + chunkSize) as never });
      }
      const { newBalance } = await recomputeAccountBalanceInTx(tx, accountId);
      await tx.auditLog.create({
        data: {
          userId,
          action: "TRADES_IMPORTED",
          entity: "Trade",
          entityId: accountId,
          meta: { count: tradesToCreate.length, duplicates, errors: errors.length },
        },
      });
      return { newBalance };
    });
    newBalance = result.newBalance.toString();
    revalidatePath("/app/trades");
    revalidatePath(`/app/accounts/${accountId}`);
    revalidatePath("/app/dashboard");
    revalidatePath("/app/analytics");
  }

  return {
    ok: true,
    imported,
    duplicates,
    errors,
    message: `Imported ${imported} trade${imported === 1 ? "" : "s"}. ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped. ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
    newBalance,
  };
}
