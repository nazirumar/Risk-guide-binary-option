/**
 * Phase 19 acceptance test — Withdrawal Rules & Profit-Taking.
 *
 * Covers the full profit-taking loop end-to-end:
 *   1. CREATE RULE: add a PERCENT_OF_PROFIT 20% WEEKLY rule for the account;
 *      the Withdrawal page shows the rule + the recommended amount.
 *   2. MARK WITHDRAWN: trigger the dialog with the pre-filled recommended
 *      amount; confirm → WITHDRAWAL transaction created + balance recomputed
 *      to (balance - amount) + rule's lastTriggeredAt stamped + audit log.
 *   3. EDGE CASE: no-profit recommendation is 0 — the "Mark as withdrawn"
 *      button isn't shown when the recommendation is 0.
 *   4. RULE UPDATE: edit the rule's value → the new recommendation reflects.
 *   5. BANKED-VS-AT-RISK: dashboard card shows the banked profit and
 *      at-risk balance after the withdrawal.
 *
 * Setup uses the DB directly (register→onboarding e2e has a known Phase 4
 * issue). The user has one DEMO account with a 1000 starting balance + a 200
 * DEPOSIT (balance 1200, profit 200).
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import Decimal from "decimal.js";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });

const email = `e2e-wr+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";
let accountId = "";

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "WR E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
  userId = user.id;

  const account = await db.tradingAccount.create({
    data: {
      userId,
      name: "E2E Withdrawal",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
  accountId = account.id;

  // Seed a 200 DEPOSIT so the balance is 1200 (profit 200 since start).
  await db.transaction.create({
    data: {
      tradingAccountId: accountId,
      type: "DEPOSIT",
      amount: new Decimal("200"),
      occurredAt: new Date(),
    },
  });
  await db.$transaction(async (tx) => {
    const acc = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { startingBalance: true },
    });
    const txs = await tx.transaction.findMany({
      where: { tradingAccountId: accountId },
      select: { type: true, amount: true },
    });
    const trades = await tx.trade.findMany({
      where: { tradingAccountId: accountId, result: { in: ["WIN", "LOSS", "TIE"] } },
      select: { profitLoss: true },
    });
    let running = new Decimal(acc.startingBalance.toString());
    for (const t of txs) {
      const amt = new Decimal(t.amount.toString());
      running = running.plus(t.type === "WITHDRAWAL" ? amt.neg() : amt);
    }
    for (const t of trades) running = running.plus(new Decimal(t.profitLoss.toString()));
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: { currentBalance: running },
    });
  });

  // Set the active-account cookie via DB only — the page reads the cookie at
  // runtime. Playwright's `context.addCookies` will set it after login.
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
  // Ensure the active account cookie is set to our test account.
  const context = page.context();
  await context.addCookies([
    {
      name: "riskguard.active-account",
      value: accountId,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
}

test("1. create rule + recommended amount appears on the Withdrawal page", async ({ page }) => {
  await login(page);
  await page.goto("/app/withdrawal");

  // Create a PERCENT_OF_PROFIT 20% WEEKLY rule.
  await page.getByTestId("wr-type-select").selectOption("PERCENT_OF_PROFIT");
  await page.getByTestId("wr-value-input").fill("20");
  await page.getByTestId("wr-frequency-select").selectOption("WEEKLY");
  await page.getByTestId("wr-baseline-select").selectOption("STARTING_BALANCE");
  await page.getByTestId("wr-save").click();

  await expect(page.getByText("Withdrawal rule created.")).toBeVisible({
    timeout: 20000,
  });

  // The stat grid shows "Recommended withdrawal" of $40 (20% of $200 profit).
  await page.reload();
  await expect(page.getByText("Recommended withdrawal")).toBeVisible();
  await expect(page.getByText("$40.00", { exact: true })).toBeVisible();

  // The "Mark as withdrawn" trigger is visible (recommendation > 0).
  await expect(page.getByTestId("mark-withdrawn-trigger")).toBeVisible();

  // DB: the rule exists with the right shape.
  const rule = await db.withdrawalRule.findFirst({
    where: { userId, tradingAccountId: accountId },
  });
  expect(rule, "rule should be saved").toBeTruthy();
  expect(rule!.type).toBe("PERCENT_OF_PROFIT");
  expect(rule!.value.toString()).toBe("20");
  expect(rule!.frequency).toBe("WEEKLY");
  expect(rule!.baseline).toBe("STARTING_BALANCE");
});

test("2. mark withdrawn → creates WITHDRAWAL + recomputes balance + stamps rule", async ({
  page,
}) => {
  await login(page);
  await page.goto("/app/withdrawal");

  await page.getByTestId("mark-withdrawn-trigger").click();
  const dialog = page.getByTestId("mark-withdrawn-dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  // Pre-filled with $40 (the recommended amount).
  await expect(page.getByTestId("withdrawal-amount-input")).toHaveValue("40.00");

  await page.getByTestId("withdrawal-confirm").click();
  await expect(page.getByText("Withdrawal recorded", { exact: false })).toBeVisible({
    timeout: 30000,
  });
  await expect(dialog).toBeHidden({ timeout: 10000 });

  // DB: a WITHDRAWAL transaction exists with amount = 40.
  const wd = await db.transaction.findFirst({
    where: { tradingAccountId: accountId, type: "WITHDRAWAL" },
  });
  expect(wd, "withdrawal transaction should be created").toBeTruthy();
  expect(wd!.amount.toString()).toBe("40");

  // Account balance recomputed to 1160 (1200 - 40).
  const account = await db.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { currentBalance: true },
  });
  expect(account.currentBalance.toString()).toBe("1160");

  // Rule's lastTriggeredAt is stamped.
  const rule = await db.withdrawalRule.findFirstOrThrow({
    where: { userId, tradingAccountId: accountId },
  });
  expect(rule.lastTriggeredAt).toBeInstanceOf(Date);

  // Audit log: WITHDRAWAL_RECORDED.
  const log = await db.auditLog.findFirst({
    where: { userId, action: "WITHDRAWAL_RECORDED" },
  });
  expect(log, "audit log should exist").toBeTruthy();
});

test("3. edge case: no-profit recommendation = 0 hides the 'Mark as withdrawn' button", async ({
  page,
}) => {
  // After test 2 the balance is 1160; profit since start = 1160 - 1000 = 160.
  // Recommended = 20% × 160 = $32. So the button should STILL be visible.
  // To test the no-profit case we need to push the balance below starting —
  // do a quick ADJUSTMENT to bring it to 950 (profit = -50, recommended = 0).
  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: accountId,
        type: "ADJUSTMENT",
        amount: new Decimal("-210"), // 1160 - 210 = 950
        occurredAt: new Date(),
      },
    });
    const acc = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { startingBalance: true },
    });
    const txs = await tx.transaction.findMany({
      where: { tradingAccountId: accountId },
      select: { type: true, amount: true },
    });
    let running = new Decimal(acc.startingBalance.toString());
    for (const t of txs) {
      const amt = new Decimal(t.amount.toString());
      running = running.plus(t.type === "WITHDRAWAL" ? amt.neg() : amt);
    }
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: { currentBalance: running },
    });
  });

  await login(page);
  await page.goto("/app/withdrawal");
  await expect(page).toHaveURL(/\/app\/withdrawal/, { timeout: 20000 });

  // Stat grid shows "Recommended withdrawal" of $0.00.
  await expect(page.getByText("Recommended withdrawal")).toBeVisible();
  await expect(page.getByText("$0.00", { exact: true })).toBeVisible();

  // The "Mark as withdrawn" trigger is hidden (recommendation = 0).
  await expect(page.getByTestId("mark-withdrawn-trigger")).toHaveCount(0);

  // Reset the balance for the next test — undo the ADJUSTMENT.
  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        tradingAccountId: accountId,
        type: "ADJUSTMENT",
        amount: new Decimal("250"), // 950 + 250 = 1200 (back to profitable)
        occurredAt: new Date(),
      },
    });
    const acc = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { startingBalance: true },
    });
    const txs = await tx.transaction.findMany({
      where: { tradingAccountId: accountId },
      select: { type: true, amount: true },
    });
    let running = new Decimal(acc.startingBalance.toString());
    for (const t of txs) {
      const amt = new Decimal(t.amount.toString());
      running = running.plus(t.type === "WITHDRAWAL" ? amt.neg() : amt);
    }
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: { currentBalance: running },
    });
  });
});

test("4. rule update: change value → recommendation updates", async ({ page }) => {
  await login(page);
  await page.goto("/app/withdrawal");
  // Balance is now 1200 (after reset); profit = 200, current recommendation = $40.

  // Edit the rule to 50% instead of 20%.
  await page.getByTestId("wr-value-input").fill("50");
  await page.getByTestId("wr-save").click();
  await expect(page.getByText("Rule updated.")).toBeVisible({
    timeout: 20000,
  });

  // Reload → new recommendation = 50% × 200 = $100.
  await page.reload();
  await expect(page.getByText("Recommended withdrawal")).toBeVisible();
  await expect(page.getByText("$100.00", { exact: true })).toBeVisible();

  // DB: rule value is now 50.
  const rule = await db.withdrawalRule.findFirstOrThrow({
    where: { userId, tradingAccountId: accountId },
  });
  expect(rule.value.toString()).toBe("50");
});

test("5. dashboard banked-vs-at-risk card is accurate after the withdrawal", async ({ page }) => {
  await login(page);
  await page.goto("/app/dashboard");
  await expect(page.getByTestId("banked-vs-at-risk")).toBeVisible({ timeout: 20000 });

  // Banked = totalWithdrawn (40) - totalDeposited (200) = -160.
  await expect(page.getByTestId("banked-amount")).toContainText("160");
  // The "banked" rendering prefixes "−" for negative — match either sign.
  // At-risk = currentBalance = 1200.
  await expect(page.getByTestId("at-risk-amount")).toContainText("1,200");
});
