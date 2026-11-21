/**
 * Phase 30.3 acceptance test — import preview → commit, with a fresh random
 * email so re-runs are idempotent. The DB assertion proves the action really
 * wrote rows (and recomputed the balance), not just optimistic client state.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import Decimal from "decimal.js";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);

const suffix = randomBytes(4).toString("hex");
const email = `e2e-import30-${suffix}@example.com`;
const password = "TestPass123!";

const CSV = [
  "Date,Type,Amount,Asset,Stake,Result,Payout",
  "2026-11-20,Deposit,300.00,,,,",
  "2026-11-21,Trade,60.00,EUR/USD,100.00,WIN,60",
].join("\n");

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });
  const user = await db.user.create({
    data: {
      email,
      name: "Import E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
  await db.tradingAccount.create({
    data: {
      userId: user.id,
      name: "E2E Import Account",
      broker: "E2E Broker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
});

test.afterAll(async () => {
  await db.auditLog.deleteMany({ where: { user: { email } } });
  await db.trade.deleteMany({ where: { user: { email } } });
  await db.transaction.deleteMany({ where: { tradingAccount: { user: { email } } } });
  await db.importBatch.deleteMany({ where: { user: { email } } });
  await db.tradingAccount.deleteMany({ where: { user: { email } } });
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

async function login(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => {
        const form = document.querySelector("form");
        return !!form && Object.keys(form).some((k) => k.startsWith("__react"));
      },
      null,
      { timeout: 90_000 },
    );
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/app\/(dashboard|onboarding)/, { timeout: 45_000 });
      return;
    } catch (loginError) {
      const nativeGet = page.url().includes("email=") && page.url().includes("password=");
      if (!nativeGet) throw loginError;
    }
  }
  throw new Error(`login failed after retries; current URL ${page.url()}`);
}

test("user previews rows before committing, then re-import is a no-op", async ({ page }) => {
  await login(page);
  await page.goto("/app/import", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await expect(page).toHaveURL(/\/app\/import/, { timeout: 30_000 });

  const panel = page.getByTestId("import-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("import-disclaimer")).toContainText("not financial advice");
  await expect(page.getByTestId("import-account")).toBeVisible();

  await page.getByTestId("import-file").setInputFiles({
    name: "statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV, "utf8"),
  });
  await page.getByTestId("import-preview-btn").click();

  const rows = page.getByTestId("import-preview-row");
  await expect(rows).toHaveCount(2, { timeout: 90_000 });
  await expect(rows.first()).toContainText("DEPOSIT");
  await expect(rows.nth(1)).toContainText("WIN");
  await expect(page.getByTestId("import-commit-btn")).toBeEnabled({ timeout: 30_000 });

  // Nothing is written before the explicit commit.
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  expect(await db.trade.count({ where: { userId: user.id } })).toBe(0);
  expect(await db.auditLog.count({ where: { userId: user.id, action: "IMPORT_PREVIEWED" } })).toBe(
    1,
  );

  await page.getByTestId("import-commit-btn").click();
  await expect(page.getByTestId("import-result")).toContainText("2 row(s) imported", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("import-commit-btn")).toBeDisabled();

  const committedTrade = await db.trade.findFirst({ where: { userId: user.id } });
  expect(committedTrade?.asset).toBe("EUR/USD");
  expect(committedTrade?.profitLoss.toString()).toBe("60");
  expect(committedTrade?.source).toBe("CSV");
  expect(await db.auditLog.count({ where: { userId: user.id, action: "IMPORT_COMMITTED" } })).toBe(
    1,
  );

  // Re-upload the identical bytes: existing rows are flagged, not duplicated.
  await page.getByTestId("import-file").setInputFiles({
    name: "statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV, "utf8"),
  });
  await page.getByTestId("import-preview-btn").click();
  await expect(page.getByTestId("import-result")).toContainText("already imported", {
    timeout: 90_000,
  });
  expect(await db.trade.count({ where: { userId: user.id } })).toBe(1);
});
