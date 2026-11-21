"use server";

/**
 * Phase 30.3 — broker statement / screenshot import actions.
 *
 * Two-step, user-initiated flow:
 *   1. `previewStatementImportAction` validates + stores the uploaded bytes,
 *      normalizes rows (Groq column mapping when configured, deterministic
 *      aliases otherwise), records an ImportBatch and logs IMPORT_PREVIEWED.
 *      Never writes a Trade/Transaction.
 *   2. `commitStatementImportAction` writes the approved rows inside ONE
 *      `db.$transaction`, calls `recomputeAccountBalanceInTx()` so
 *      balanceAfter stays consistent, and is idempotent by
 *      (userId, source, externalId).
 *
 * Uploaded statement text is untrusted: the AI mapping prompt only ever asks
 * for column *indices*, never for row values or instructions.
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";

import { db } from "@/lib/db";
import { getAIProvider } from "@/lib/ai/provider";
import { computeTradeProfitLoss } from "@/lib/calc/trade";
import { storeUploadedFile } from "@/lib/storage";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import { requireUser } from "@/server/lib/require-user";
import {
  ALLOWED_IMPORT_TYPES,
  buildMappingPrompt,
  buildPreviewRows,
  checksumOf,
  IMPORT_SOURCES,
  importFileSchema,
  importMaxBytes,
  MAPPING_SYSTEM_PROMPT,
  normalizeRows,
  normalizedRowSchema,
  parseMappingResponse,
  tableFromText,
  autoColumnMap,
  type ImportSource,
  type StatementPreviewRow,
} from "@/lib/import/statement";

// ─── Result shapes ──────────────────────────────────────────────────────────

export type StatementPreviewResult = {
  ok: boolean;
  message?: string;
  batchId?: string;
  source?: ImportSource;
  fileName?: string;
  fileUrl?: string | null;
  headers?: string[];
  rows?: StatementPreviewRow[];
  validCount?: number;
  duplicateCount?: number;
  errorCount?: number;
  mappingSource?: "ai" | "auto";
  alreadyCommitted?: boolean;
};

export type StatementCommitResult = {
  ok: boolean;
  message?: string;
  committed?: number;
  duplicates?: number;
  newBalance?: string;
  alreadyCommitted?: boolean;
};

// ─── Persisted JSON shape ───────────────────────────────────────────────────

const storedRowSchema = normalizedRowSchema.extend({
  externalId: z.string().min(1).max(64),
  rowNumber: z.number().int().positive(),
});

const storedBatchSchema = z.object({
  version: z.literal(1),
  headers: z.array(z.string()),
  rows: z.array(storedRowSchema),
  errors: z.array(z.object({ row: z.number().int().positive(), message: z.string() })),
  rawRows: z.array(z.array(z.string())),
  mappingSource: z.enum(["ai", "auto"]),
  fileName: z.string(),
  checksum: z.string(),
});

type StoredBatch = z.infer<typeof storedBatchSchema>;

function readStoredBatch(value: Prisma.JsonValue): StoredBatch | null {
  const parsed = storedBatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sourceForFile(type: string): ImportSource {
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("image/")) return "IMAGE";
  return "CSV";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected import error.";
}

/** Ids already imported for this user (across both trades and transactions). */
async function existingExternalIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const accounts = await db.tradingAccount.findMany({ where: { userId }, select: { id: true } });
  const [trades, transactions] = await Promise.all([
    db.trade.findMany({
      where: { userId, externalId: { in: ids } },
      select: { externalId: true },
    }),
    db.transaction.findMany({
      where: {
        tradingAccountId: { in: accounts.map((a) => a.id) },
        externalId: { in: ids },
      },
      select: { externalId: true },
    }),
  ]);
  return new Set(
    [...trades, ...transactions]
      .map((row) => row.externalId)
      .filter((id): id is string => Boolean(id)),
  );
}

// ─── Step 1 — preview (no Trade/Transaction writes) ─────────────────────────

export async function previewStatementImportAction(
  formData: FormData,
): Promise<StatementPreviewResult> {
  const { userId } = await requireUser();

  const accountId = String(formData.get("tradingAccountId") ?? "");
  if (!accountId) return { ok: false, message: "Choose a trading account first." };
  const account = await db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false, message: "Trading account not found." };

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return { ok: false, message: "Choose a statement file to import." };
  }

  const fileCheck = importFileSchema.safeParse({
    name: file.name,
    type: file.type,
    size: file.size,
  });
  if (!fileCheck.success) {
    return { ok: false, message: fileCheck.error.issues[0]?.message ?? "Invalid file." };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) return { ok: false, message: "The selected file is empty." };
  const checksum = checksumOf(bytes);
  const source = sourceForFile(file.type);

  // Same file re-uploaded: reuse the stored preview (the batch is user-scoped
  // by a unique (userId, checksum) constraint, so this cannot fork).
  const existing = await db.importBatch.findUnique({
    where: { userId_checksum: { userId, checksum } },
  });
  if (existing) {
    const stored = readStoredBatch(existing.rows);
    if (stored) {
      const ids = stored.rows.map((r) => r.externalId);
      const seen = await existingExternalIds(userId, ids);
      return {
        ok: true,
        batchId: existing.id,
        source: IMPORT_SOURCES.includes(existing.source as ImportSource)
          ? (existing.source as ImportSource)
          : source,
        fileName: existing.fileName ?? file.name,
        fileUrl: existing.fileUrl,
        headers: stored.headers,
        rows: buildPreviewRows(stored.rows, stored.errors, seen),
        validCount: stored.rows.filter((r) => !seen.has(r.externalId)).length,
        duplicateCount: seen.size,
        errorCount: stored.errors.length,
        mappingSource: stored.mappingSource,
        alreadyCommitted: existing.status === "COMMITTED",
        message:
          existing.status === "COMMITTED"
            ? "This statement was already imported. No new rows will be created."
            : "Previously uploaded statement — review the rows before committing.",
      };
    }
  }

  // CSV/TSV is parsed locally. PDF/image bytes go through the storage layer;
  // Groq maps the pasted text layer/OCR output into normalized rows.
  let text = "";
  if (source === "CSV") {
    text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  } else {
    text = String(formData.get("ocrText") ?? "").trim();
    if (!text) {
      return {
        ok: false,
        message:
          "This format needs extracted text. Paste the PDF text layer or OCR output in the text box to preview rows.",
      };
    }
  }
  if (!text.trim()) return { ok: false, message: "The statement contains no readable text." };

  const { headers, rows: rawRows } = tableFromText(text);
  if (headers.length === 0) return { ok: false, message: "No header row found in the statement." };

  let map = autoColumnMap(headers);
  let mappingSource: "ai" | "auto" = "auto";
  const provider = getAIProvider();
  if (provider && map.amount !== null) {
    try {
      const completion = await provider.complete(
        buildMappingPrompt(headers, rawRows),
        MAPPING_SYSTEM_PROMPT,
        { maxTokens: 400, temperature: 0, timeoutMs: 15_000 },
      );
      const aiMap = parseMappingResponse(completion);
      if (aiMap && Object.values(aiMap).some((v) => v !== null)) {
        map = aiMap;
        mappingSource = "ai";
      }
    } catch {
      // Groq failure (rate limit / offline) → deterministic mapping fallback.
    }
  }

  const mapped = normalizeRows(headers, rawRows, map, source, checksum);
  const seen = await existingExternalIds(
    userId,
    mapped.rows.map((r) => r.externalId),
  );

  // Store the original bytes through the existing storage abstraction. A
  // storage misconfiguration must not block the journal import itself.
  let fileUrl: string | null = null;
  let storageError: string | null = null;
  try {
    fileUrl = (await storeUploadedFile(file)).url;
  } catch (err) {
    storageError = errorMessage(err);
  }

  const stored: StoredBatch = {
    version: 1,
    headers,
    rows: mapped.rows,
    errors: mapped.errors,
    rawRows: rawRows.slice(0, 200),
    mappingSource,
    fileName: file.name,
    checksum,
  };

  try {
    const batch = await db.importBatch.create({
      data: {
        userId,
        source,
        status: "PREVIEW",
        rows: stored as unknown as Prisma.InputJsonValue,
        fileName: file.name,
        fileUrl,
        checksum,
      },
      select: { id: true },
    });

    await db.auditLog.create({
      data: {
        userId,
        action: "IMPORT_PREVIEWED",
        entity: "ImportBatch",
        entityId: batch.id,
        meta: {
          source,
          fileName: file.name,
          checksum,
          valid: mapped.rows.length,
          errors: mapped.errors.length,
          duplicates: seen.size,
          mappingSource,
          storageError,
          maxBytes: importMaxBytes(),
          allowedTypes: [...ALLOWED_IMPORT_TYPES],
        },
      },
    });

    return {
      ok: true,
      batchId: batch.id,
      source,
      fileName: file.name,
      fileUrl,
      headers,
      rows: buildPreviewRows(mapped.rows, mapped.errors, seen),
      validCount: mapped.rows.filter((r) => !seen.has(r.externalId)).length,
      duplicateCount: seen.size,
      errorCount: mapped.errors.length,
      mappingSource,
      message: storageError
        ? `Rows parsed, but the original file could not be archived (${storageError}).`
        : undefined,
    };
  } catch (err) {
    await db.auditLog.create({
      data: {
        userId,
        action: "IMPORT_FAILED",
        entity: "ImportBatch",
        entityId: checksum,
        meta: { source, fileName: file.name, checksum, phase: "preview", error: errorMessage(err) },
      },
    });
    return { ok: false, message: `Could not create the import preview: ${errorMessage(err)}` };
  }
}

// ─── Step 2 — transactional commit ─────────────────────────────────────────

const commitSchema = z.object({
  batchId: z.string().min(1),
  tradingAccountId: z.string().min(1),
});

function openedAtFor(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function payoutDecimal(raw: string | undefined): Decimal {
  if (!raw) return new Decimal(1);
  let p = new Decimal(raw);
  if (p.gt(1)) p = p.div(100); // statements may say "85" meaning 85%
  return p.toDecimalPlaces(4);
}

export async function commitStatementImportAction(
  formData: FormData,
): Promise<StatementCommitResult> {
  const { userId } = await requireUser();
  const parsed = commitSchema.safeParse({
    batchId: formData.get("batchId"),
    tradingAccountId: formData.get("tradingAccountId"),
  });
  if (!parsed.success) return { ok: false, message: "Missing import batch or trading account." };

  const account = await db.tradingAccount.findFirst({
    where: { id: parsed.data.tradingAccountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false, message: "Trading account not found." };

  const batch = await db.importBatch.findFirst({
    where: { id: parsed.data.batchId, userId },
  });
  if (!batch) return { ok: false, message: "Import batch not found." };

  if (batch.status === "COMMITTED") {
    return {
      ok: true,
      alreadyCommitted: true,
      committed: batch.committed,
      duplicates: batch.duplicates,
      message: "This statement was already imported — no rows were duplicated.",
    };
  }

  const stored = readStoredBatch(batch.rows);
  if (!stored) {
    await db.auditLog.create({
      data: {
        userId,
        action: "IMPORT_FAILED",
        entity: "ImportBatch",
        entityId: batch.id,
        meta: { phase: "commit", error: "Stored preview could not be read" },
      },
    });
    return { ok: false, message: "The stored preview could not be read. Please re-upload." };
  }

  try {
    const result = await db.$transaction(
      async (tx) => {
        const tradeCreates: Prisma.TradeCreateManyInput[] = [];
        const transactionCreates: Prisma.TransactionCreateManyInput[] = [];
        const seen = new Set<string>();
        let duplicates = 0;

        // One batched lookup instead of 2 queries per row — remote Neon
        // round-trips would otherwise blow the interactive-transaction timeout.
        const ids = stored.rows.map((r) => r.externalId).filter(Boolean);
        const accounts = await tx.tradingAccount.findMany({
          where: { userId },
          select: { id: true },
        });
        const [existingTrades, existingTransactions] = await Promise.all([
          tx.trade.findMany({
            where: { userId, externalId: { in: ids } },
            select: { externalId: true },
          }),
          tx.transaction.findMany({
            where: {
              tradingAccountId: { in: accounts.map((a) => a.id) },
              externalId: { in: ids },
            },
            select: { externalId: true },
          }),
        ]);
        const already = new Set(
          [...existingTrades, ...existingTransactions]
            .map((r) => r.externalId)
            .filter((id): id is string => Boolean(id)),
        );

        for (const row of stored.rows) {
          if (!row.externalId || seen.has(row.externalId) || already.has(row.externalId)) {
            duplicates++;
            continue;
          }
          const openedAt = openedAtFor(row.date);
          if (Number.isNaN(openedAt.getTime())) continue;
          seen.add(row.externalId);

          if (row.type === "TRADE") {
            const stake = row.stake ? new Decimal(row.stake).abs() : new Decimal(row.amount).abs();
            const payout = payoutDecimal(row.payoutPercent);
            const resultType =
              row.result ?? (new Decimal(row.amount).isNegative() ? "LOSS" : "WIN");
            const profitLoss = computeTradeProfitLoss(stake, payout, resultType).toDecimalPlaces(2);
            const expiryMinutes = row.expiryMinutes ?? 5;
            const closedAt =
              resultType === "OPEN" ? null : new Date(openedAt.getTime() + expiryMinutes * 60_000);

            tradeCreates.push({
              userId,
              tradingAccountId: account.id,
              asset: row.asset?.trim() || "IMPORTED",
              direction: row.direction === "PUT" ? "PUT" : "CALL",
              stake: stake.toDecimalPlaces(2),
              payoutPercent: payout,
              expiryMinutes,
              openedAt,
              closedAt,
              result: resultType,
              profitLoss,
              followedPlan: false,
              setupNotes: row.note?.slice(0, 500) ?? null,
              source: batch.source,
              externalId: row.externalId,
              importBatchId: batch.id,
            });
          } else {
            const amount = new Decimal(row.amount);
            transactionCreates.push({
              tradingAccountId: account.id,
              type: row.type,
              // recomputeAccountBalanceInTx subtracts WITHDRAWAL amounts by
              // type, so the stored amount must be positive.
              amount: (row.type === "WITHDRAWAL" ? amount.abs() : amount).toDecimalPlaces(2),
              note:
                row.note?.slice(0, 500) ??
                `Imported ${batch.source} ${stored.fileName}`.slice(0, 500),
              occurredAt: openedAt,
              source: batch.source,
              externalId: row.externalId,
              importBatchId: batch.id,
            });
          }
        }

        let committed = 0;
        for (let i = 0; i < tradeCreates.length; i += 50) {
          committed += (
            await tx.trade.createMany({
              data: tradeCreates.slice(i, i + 50),
              skipDuplicates: true,
            })
          ).count;
        }
        for (let i = 0; i < transactionCreates.length; i += 50) {
          committed += (
            await tx.transaction.createMany({
              data: transactionCreates.slice(i, i + 50),
              skipDuplicates: true,
            })
          ).count;
        }

        let newBalance: Decimal | null = null;
        if (committed > 0) {
          ({ newBalance } = await recomputeAccountBalanceInTx(tx, account.id));
        }

        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: "COMMITTED",
            committed,
            duplicates,
            errorSummary: stored.errors.length
              ? `${stored.errors.length} row(s) were invalid and skipped in preview.`
              : null,
          },
        });

        await tx.auditLog.create({
          data: {
            userId,
            action: "IMPORT_COMMITTED",
            entity: "ImportBatch",
            entityId: batch.id,
            meta: {
              source: batch.source,
              fileName: stored.fileName,
              checksum: batch.checksum,
              committed,
              duplicates,
              errors: stored.errors.length,
              newBalance: newBalance?.toString() ?? null,
              tradingAccountId: account.id,
            },
          },
        });

        return { committed, duplicates, newBalance };
      },
      // Remote Neon + a full equity recompute needs more than the 5s default.
      { maxWait: 20_000, timeout: 120_000 },
    );

    revalidatePath("/app/import");
    revalidatePath("/app/trades");
    revalidatePath("/app/accounts");
    revalidatePath(`/app/accounts/${account.id}`);
    revalidatePath("/app/dashboard");
    revalidatePath("/app/analytics");
    revalidatePath("/app/reports");

    return {
      ok: true,
      committed: result.committed,
      duplicates: result.duplicates,
      newBalance: result.newBalance?.toString(),
      message: `${result.committed} row(s) imported, ${result.duplicates} duplicate(s) skipped.`,
    };
  } catch (err) {
    const reason = errorMessage(err);
    try {
      await db.importBatch.update({
        where: { id: batch.id },
        data: { status: "FAILED", errorSummary: reason.slice(0, 500) },
      });
      await db.auditLog.create({
        data: {
          userId,
          action: "IMPORT_FAILED",
          entity: "ImportBatch",
          entityId: batch.id,
          meta: { source: batch.source, checksum: batch.checksum, phase: "commit", error: reason },
        },
      });
    } catch {
      // Best-effort audit — the original failure is returned to the user.
    }
    return { ok: false, message: `Import failed and was rolled back: ${reason}` };
  }
}

/** Recent import batches for the current user (audit view). */
export async function listImportBatchesAction() {
  const { userId } = await requireUser();
  return db.importBatch.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      source: true,
      status: true,
      fileName: true,
      fileUrl: true,
      rows: true,
      committed: true,
      duplicates: true,
      errorSummary: true,
      createdAt: true,
    },
  });
}
