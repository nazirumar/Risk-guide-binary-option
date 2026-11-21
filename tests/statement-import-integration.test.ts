/**
 * Phase 30.3 — integration tests for the real statement-import actions.
 *
 * Uses the live DB in .env (same pattern as the coach action tests). Covers
 * preview-without-writes, transactional commit + balance recompute,
 * (userId, source, externalId) idempotency, ownership scoping and audit logs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

const prisma = new PrismaClient();

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  storeUploadedFile: vi.fn(async (file: File) => ({
    url: `/api/upload/test-${file.name}`,
    originalName: file.name,
    contentType: file.type,
    size: file.size,
  })),
}));

let currentTestUserId: string | null = null;
vi.mock("@/server/lib/require-user", () => ({
  requireUser: async () => {
    if (!currentTestUserId) throw new Error("test userId not set");
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: currentTestUserId },
      select: {
        id: true,
        email: true,
        name: true,
        isOnboarded: true,
        emailVerified: true,
        timezone: true,
        baseCurrency: true,
      },
    });
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      isOnboarded: u.isOnboarded,
      emailVerified: u.emailVerified,
      timezone: u.timezone,
      baseCurrency: u.baseCurrency,
    };
  },
}));

import {
  commitStatementImportAction,
  previewStatementImportAction,
} from "@/server/actions/statement-import";
import { setAIProvider } from "@/lib/ai/provider";

const CSV = [
  "Date,Type,Amount,Asset,Stake,Result,Payout",
  "2026-11-20,Deposit,500.00,,,,",
  "2026-11-21,Withdrawal,25.50,,,,",
  "2026-11-22,Trade,85.00,EUR/USD,100.00,WIN,85",
].join("\n");

function csvForm(accountId: string, bytes = CSV): FormData {
  const fd = new FormData();
  fd.set("tradingAccountId", accountId);
  fd.set("file", new File([bytes], "broker-statement.csv", { type: "text/csv" }));
  return fd;
}

function commitForm(batchId: string, accountId: string): FormData {
  const fd = new FormData();
  fd.set("batchId", batchId);
  fd.set("tradingAccountId", accountId);
  return fd;
}

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: "Import Test",
      passwordHash: await argon2.hash("TestPass123!"),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
}

async function makeAccount(userId: string) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      name: "Import Account",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
}

beforeEach(async () => {
  // Subscription first: the documented RESTRICT FK teardown trap.
  await prisma.subscription.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.balanceCheck.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.user.deleteMany();
  currentTestUserId = null;
  setAIProvider(null); // deterministic header aliases, no network call
});

afterAll(async () => {
  setAIProvider(null);
  await prisma.$disconnect();
});

describe("Phase 30.3 — statement import actions", () => {
  it("previews without writing any journal rows, then commits with a recomputed balance", async () => {
    const user = await makeUser(`import-preview-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    const account = await makeAccount(user.id);

    const preview = await previewStatementImportAction(csvForm(account.id));
    expect(preview.ok).toBe(true);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows?.every((r) => r.status === "ok")).toBe(true);
    expect(preview.mappingSource).toBe("auto");
    expect(preview.validCount).toBe(3);
    expect(preview.batchId).toBeTruthy();

    // Preview is strictly read-only for the journal.
    expect(await prisma.trade.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.importBatch.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { userId: user.id, action: "IMPORT_PREVIEWED" } }),
    ).toBe(1);

    const commit = await commitStatementImportAction(commitForm(preview.batchId!, account.id));
    expect(commit.ok).toBe(true);
    expect(commit.committed).toBe(3);
    expect(commit.duplicates).toBe(0);
    // 1000 start + 500 deposit - 25.50 withdrawal + 85 win = 1559.50
    expect(commit.newBalance).toBe("1559.5");

    const trades = await prisma.trade.findMany({ where: { userId: user.id } });
    expect(trades).toHaveLength(1);
    expect(trades[0].profitLoss.toString()).toBe("85");
    expect(trades[0].balanceAfter?.toString()).toBe("1559.5");
    expect(trades[0].source).toBe("CSV");
    expect(trades[0].externalId).toBeTruthy();

    const transactions = await prisma.transaction.findMany({
      where: { tradingAccountId: account.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[0].type).toBe("DEPOSIT");
    expect(transactions[0].amount.toString()).toBe("500");
    expect(transactions[1].type).toBe("WITHDRAWAL");
    expect(transactions[1].amount.toString()).toBe("25.5");

    const fresh = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(fresh.currentBalance.toString()).toBe("1559.5");

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } });
    expect(batch.status).toBe("COMMITTED");
    expect(batch.committed).toBe(3);
    expect(
      await prisma.auditLog.count({ where: { userId: user.id, action: "IMPORT_COMMITTED" } }),
    ).toBe(1);
  });

  it("is idempotent: re-uploading the same bytes reuses the batch and creates no duplicates", async () => {
    const user = await makeUser(`import-idem-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    const account = await makeAccount(user.id);

    const first = await previewStatementImportAction(csvForm(account.id));
    expect(first.ok).toBe(true);
    await commitStatementImportAction(commitForm(first.batchId!, account.id));

    const second = await previewStatementImportAction(csvForm(account.id));
    expect(second.ok).toBe(true);
    expect(second.batchId).toBe(first.batchId);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.rows?.every((r) => r.status === "duplicate")).toBe(true);

    const recommit = await commitStatementImportAction(commitForm(second.batchId!, account.id));
    expect(recommit.ok).toBe(true);
    expect(recommit.alreadyCommitted).toBe(true);
    expect(recommit.committed).toBe(3);

    expect(await prisma.trade.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.transaction.count()).toBe(2);
    expect(await prisma.importBatch.count({ where: { userId: user.id } })).toBe(1);
  });

  it("does not let another user commit someone else's batch", async () => {
    const owner = await makeUser(`import-owner-${Date.now()}@example.com`);
    const other = await makeUser(`import-other-${Date.now()}@example.com`);
    const account = await makeAccount(owner.id);

    currentTestUserId = owner.id;
    const preview = await previewStatementImportAction(csvForm(account.id));
    expect(preview.ok).toBe(true);

    currentTestUserId = other.id;
    const stolen = await commitStatementImportAction(commitForm(preview.batchId!, account.id));
    expect(stolen.ok).toBe(false);
    expect(stolen.message).toMatch(/account not found/i);
    expect(await prisma.trade.count()).toBe(0);

    // Even with their own account, the batch id is user-scoped.
    const otherAccount = await makeAccount(other.id);
    const stolenBatch = await commitStatementImportAction(
      commitForm(preview.batchId!, otherAccount.id),
    );
    expect(stolenBatch.ok).toBe(false);
    expect(stolenBatch.message).toMatch(/batch not found/i);
    expect(await prisma.trade.count()).toBe(0);
  });

  it("keeps invalid rows out of the commit and audits a failed batch", async () => {
    const user = await makeUser(`import-invalid-${Date.now()}@example.com`);
    currentTestUserId = user.id;
    const account = await makeAccount(user.id);

    const preview = await previewStatementImportAction(
      csvForm(account.id, "Date,Type,Amount\n2026-11-20,Deposit,100\nbad-date,Deposit,50\n"),
    );
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(1);
    expect(preview.rows?.find((r) => r.status === "error")?.error).toMatch(/date/i);

    const commit = await commitStatementImportAction(commitForm(preview.batchId!, account.id));
    expect(commit.ok).toBe(true);
    expect(commit.committed).toBe(1);
    expect(await prisma.transaction.count()).toBe(1);

    // A corrupt stored preview is rejected and logged as IMPORT_FAILED.
    const broken = await prisma.importBatch.create({
      data: {
        userId: user.id,
        source: "CSV",
        status: "PREVIEW",
        checksum: `broken-${Date.now()}`,
        rows: { version: 99 },
      },
    });
    const failed = await commitStatementImportAction(commitForm(broken.id, account.id));
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/could not be read/i);
    expect(
      await prisma.auditLog.count({ where: { userId: user.id, action: "IMPORT_FAILED" } }),
    ).toBe(1);
  });
});
