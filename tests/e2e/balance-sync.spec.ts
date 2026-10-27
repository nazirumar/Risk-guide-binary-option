/**
 * Phase 18 acceptance test — Broker Balance Sync Checks.
 *
 * Covers the full sync loop end-to-end:
 *   1. MATCHED: enter broker balance equal to app → check row saved MATCHED,
 *      no ADJUSTMENT transaction, no balance change.
 *   2. ADJUSTED: enter broker balance 10 over → mismatch panel shows → click
 *      "Create adjustment" → ADJUSTMENT transaction created with amount=+10,
 *      account balance recomputed to broker balance, check ADJUSTED.
 *   3. IGNORED: enter a mismatch + ignore with a note → no transaction,
 *      check IGNORED + note persisted.
 *   4. HISTORY: filters on /app/balance-sync work (filter by resolution,
 *      clear back to all).
 *   5. SETTINGS: reminder frequency OFF disables the dashboard banner
 *      (banner shouldn't render when reminder is OFF).
 *
 * Setup uses the DB directly (register→onboarding e2e has a known Phase 4
 * issue). The user has one DEMO account with a 1000 starting balance.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import Decimal from "decimal.js";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });

const email = `e2e-bs+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";
let accountId = "";

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "BS E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
      // Default reminder DAILY — banner will try to show on first dashboard
      // load. The Settings test toggles this to OFF later.
    },
  });
  userId = user.id;

  const account = await db.tradingAccount.create({
    data: {
      userId,
      name: "E2E Demo",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
  accountId = account.id;

  // The proxy expects an active-account cookie when rendering /app/* — set
  // it via the setActiveAccountId server action by writing it directly here
  // (cookie is httpOnly but Playwright can write cookies via context).
});

test.afterAll(async () => {
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/dashboard/, { timeout: 30000 });
}

async function openCheckDialog(page: Page) {
  await page.goto(`/app/accounts/${accountId}`);
  await page.getByTestId("balance-check-trigger").click();
  const dialog = page.getByTestId("balance-check-dialog");
  await expect(dialog).toBeVisible({ timeout: 20000 });
  return dialog;
}

test("1. matched: broker balance = app balance → MATCHED, no adjustment", async ({ page }) => {
  await login(page);
  const dialog = await openCheckDialog(page);

  await page.getByTestId("broker-balance-input").fill("1000");
  await page.getByTestId("balance-check-submit").click();

  await expect(page.getByTestId("balance-check-result")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("balance-check-result")).toContainText(/Matched/);

  await page.getByTestId("balance-check-done").click();
  await expect(dialog).toBeHidden({ timeout: 10000 });

  // DB: a BalanceCheck row exists with resolution MATCHED and difference 0.
  const check = await db.balanceCheck.findFirst({
    where: { userId, tradingAccountId: accountId },
    orderBy: { checkedAt: "desc" },
  });
  expect(check, "balance check should be saved").toBeTruthy();
  expect(check!.resolution).toBe("MATCHED");
  expect(check!.difference.toString()).toBe("0");

  // No ADJUSTMENT transaction was created.
  const adjCount = await db.transaction.count({
    where: { tradingAccountId: accountId, type: "ADJUSTMENT" },
  });
  expect(adjCount).toBe(0);
});

test("2. adjusted: broker +10 → adjustment created, balance recomputed", async ({ page }) => {
  await login(page);
  const dialog = await openCheckDialog(page);

  await page.getByTestId("broker-balance-input").fill("1010");
  await page.getByTestId("balance-check-submit").click();

  // Mismatch panel shows the +10 difference.
  await expect(page.getByTestId("balance-check-result")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("balance-check-result")).toContainText(/ahead by 10/);

  // "Create adjustment (+10.00)" — click to confirm.
  const adjustBtn = page.getByTestId("balance-check-adjust");
  await expect(adjustBtn).toContainText(/\+10/);
  await adjustBtn.click();

  await expect(page.getByText("Adjustment recorded", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(dialog).toBeHidden({ timeout: 10000 });

  // DB: ADJUSTMENT transaction exists with amount = +10.
  const adj = await db.transaction.findFirst({
    where: { tradingAccountId: accountId, type: "ADJUSTMENT" },
  });
  expect(adj, "adjustment transaction should be created").toBeTruthy();
  expect(adj!.amount.toString()).toBe("10");

  // Account balance recomputed to the broker balance.
  const account = await db.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { currentBalance: true },
  });
  expect(account.currentBalance.toString()).toBe("1010");

  // Check row resolved as ADJUSTED.
  const check = await db.balanceCheck.findFirst({
    where: { userId, tradingAccountId: accountId, resolution: "ADJUSTED" },
  });
  expect(check, "check should be ADJUSTED").toBeTruthy();
});

test("3. ignored: mismatch + ignore-with-note → no transaction, note persisted", async ({
  page,
}) => {
  await login(page);
  const dialog = await openCheckDialog(page);

  // Account is now 1010 (after the adjust test). Broker shows 1000 → -10.
  await page.getByTestId("broker-balance-input").fill("1000");
  await page.getByTestId("balance-check-submit").click();
  await expect(page.getByTestId("balance-check-result")).toBeVisible({ timeout: 20000 });

  await page.getByTestId("balance-check-note").fill("Broker fee, ignoring");
  await page.getByTestId("balance-check-ignore").click();

  await expect(page.getByText("Mismatch ignored", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(dialog).toBeHidden({ timeout: 10000 });

  // DB: no NEW ADJUSTMENT transaction was created (still only 1 from test 2).
  const adjCount = await db.transaction.count({
    where: { tradingAccountId: accountId, type: "ADJUSTMENT" },
  });
  expect(adjCount).toBe(1);

  // Check row resolved IGNORED with the note persisted.
  const check = await db.balanceCheck.findFirst({
    where: { userId, tradingAccountId: accountId, resolution: "IGNORED" },
  });
  expect(check, "check should be IGNORED").toBeTruthy();
  expect(check!.note).toBe("Broker fee, ignoring");
});

test("4. history: filters work (filter by ADJUSTED, then clear)", async ({ page }) => {
  await login(page);
  await page.goto("/app/balance-sync");

  // The table has at least 3 rows (one MATCHED, one ADJUSTED, one IGNORED).
  await expect(page.getByTestId("balance-sync-table")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("balance-sync-row")).not.toHaveCount(0);
  const allRows = await page.getByTestId("balance-sync-row").count();
  expect(allRows).toBeGreaterThanOrEqual(3);

  // Filter by resolution=ADJUSTED.
  await page.locator("#filter-resolution").selectOption("ADJUSTED");
  await page.getByTestId("balance-sync-apply-filters").click();
  // wait for URL to reflect the filter
  await expect(page).toHaveURL(/resolution=ADJUSTED/, { timeout: 20000 });

  // expect exactly 1 row showing now.
  await expect(page.getByTestId("balance-sync-row")).toHaveCount(1, { timeout: 20000 });
  await expect(page.getByTestId("resolution-adjusted")).toBeVisible();

  // Clear filters via the Clear link — this navigates to /app/balance-sync
  // (no params). Use a hard reload after click to be defensive against
  // Next.js client-side router timing.
  await page.getByTestId("balance-sync-clear-filters").click();
  await expect(page).toHaveURL(/\/app\/balance-sync$/, { timeout: 20000 });
  await page.reload();
  // Expect all rows back (≥3).
  await expect(page.getByTestId("balance-sync-row")).not.toHaveCount(0);
  const clearedRows = await page.getByTestId("balance-sync-row").count();
  expect(clearedRows).toBeGreaterThanOrEqual(3);
});

test("5. settings: reminder OFF disables the dashboard banner", async ({ page }) => {
  await login(page);

  // First, ensure the banner is visible by default (DAILY reminder).
  await page.goto("/app/dashboard");
  // Banner is client-rendered — give it a moment to fetch shouldPrompt.
  const banner = page.getByTestId("balance-check-prompt");
  // Default = DAILY + never prompted → banner should be visible.
  await expect(banner).toBeVisible({ timeout: 20000 });

  // Now switch to OFF in Settings.
  await page.goto("/app/settings");
  await page.getByTestId("bs-frequency-select").selectOption("OFF");
  await page.getByTestId("bs-save").click();
  await expect(page.getByText("Balance sync settings saved.")).toBeVisible({
    timeout: 30000,
  });

  // Dashboard reload → banner is now hidden (reminder OFF).
  await page.goto("/app/dashboard");
  await page.waitForLoadState("networkidle");
  // Wait a beat for the client fetch to settle; banner should not appear.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("balance-check-prompt")).toHaveCount(0);

  // DB: settings persisted.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { balanceSyncReminderFrequency: true },
  });
  expect(user?.balanceSyncReminderFrequency).toBe("OFF");

  // Reset reminder to DAILY for any future runs.
  await db.user.update({
    where: { id: userId },
    data: { balanceSyncReminderFrequency: "DAILY" },
  });
});

test("6. accounts page shows the 30-day accuracy badge", async ({ page }) => {
  await login(page);
  await page.goto("/app/accounts");
  // At least 3 checks exist now (from tests 1-3) — accuracy badge should show.
  await expect(page.locator(`[data-testid="account-accuracy-${accountId}"]`)).toBeVisible({
    timeout: 20000,
  });
  // The text should contain "%" and "check" or "checks".
  const text = await page.locator(`[data-testid="account-accuracy-${accountId}"]`).textContent();
  expect(text).toMatch(/\d+%/);
  expect(text).toMatch(/check/);
});
