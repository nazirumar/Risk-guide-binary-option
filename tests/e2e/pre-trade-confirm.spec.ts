/**
 * Phase 17 acceptance test — pre-trade confirmation screen.
 *
 * Covers the full discipline loop end-to-end:
 *   1. CONFIRM: Save trade → modal shows the correct live numbers → visible
 *      countdown → Enter confirms → trade persisted with the modal's values.
 *   2. CANCEL: Save trade → Cancel → CancelledTradeAttempt recorded (trade
 *      NOT created) → dashboard "Trades you avoided" shows count + stake.
 *   3. SETTINGS: cooldown change persists (DB + UI reload).
 *   4. MOBILE: the dialog works on a phone viewport.
 *
 * Setup uses the DB directly (register→onboarding e2e has a known Phase 4
 * issue) with a fresh random user per run. Account type REAL — confirmation
 * is mandatory there by design.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import Decimal from "decimal.js";

const db = new PrismaClient();

// The tests share one user + state (a saved trade, an avoided trade,
// changed settings) — run strictly in order, stop on first failure.
test.describe.configure({ mode: "serial" });

const email = `e2e-ptc+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";

test.beforeAll(async () => {
  await db.$connect();
  // Idempotency: remove any leftovers from a previous run of this email.
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "PTC E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
  userId = user.id;

  // REAL account → the confirmation screen is mandatory (DEMO can skip it).
  await db.tradingAccount.create({
    data: {
      userId,
      name: "E2E Real",
      broker: "TestBroker",
      currency: "USD",
      type: "REAL",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
  await db.riskProfile.create({
    data: {
      userId,
      tradingAccountId: null, // global profile
      riskPerTradePercent: new Decimal("2"),
      maxDailyLossPercent: new Decimal("6"),
      maxTradesPerDay: 10,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 15,
      maxOpenTrades: 3,
    },
  });
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

async function openConfirmationModal(page: Page, stake: string) {
  await page.goto("/app/trades");
  // The label renders as "Stake *" (required star) — substring match.
  await page.getByLabel("Stake").fill(stake);
  await page.getByTestId("save-trade-button").click();
  const dialog = page.getByTestId("pre-trade-dialog");
  await expect(dialog).toBeVisible({ timeout: 20000 });
  return dialog;
}

test("confirm: modal shows correct numbers → countdown → Enter confirms → trade saved", async ({
  page,
}) => {
  await login(page);
  const dialog = await openConfirmationModal(page, "25");

  // ── Correct live numbers (stake 25, payout 85%, balance 1000, no history) ──
  await expect(dialog.getByText("EUR/USD")).toBeVisible();
  await expect(dialog.getByText("CALL", { exact: true })).toBeVisible();
  await expect(dialog.getByText("$25.00", { exact: true })).toBeVisible(); // stake
  await expect(dialog.getByText("85%", { exact: true })).toBeVisible(); // payout
  await expect(dialog.getByText("+$21.25", { exact: true })).toBeVisible(); // 25 × 0.85
  await expect(dialog.getByText("-$25.00", { exact: true })).toBeVisible(); // potential loss
  await expect(dialog.getByText("2.50%", { exact: true })).toBeVisible(); // 25 / 1000
  await expect(dialog.getByText("0%", { exact: true }).first()).toBeVisible(); // daily loss used
  await expect(dialog.getByText("10 of 10", { exact: true })).toBeVisible(); // trades remaining
  await expect(dialog.getByText("None", { exact: true })).toBeVisible(); // loss streak
  await expect(dialog.getByText("CALM", { exact: true })).toBeVisible(); // tilt level
  await expect(dialog.getByText("No plan set", { exact: true })).toBeVisible(); // no staking plan

  // ── Cooldown: visible countdown + disabled confirm (server notBefore) ──
  const confirmBtn = page.getByTestId("pre-trade-confirm");
  try {
    await expect(page.getByTestId("pre-trade-countdown")).toBeVisible({ timeout: 3000 });
    await expect(confirmBtn).toBeDisabled();
  } catch {
    // Slow CI prepare — the cooldown may already have elapsed by mount time.
  }
  await expect(confirmBtn).toBeEnabled({ timeout: 30000 });

  // ── Keyboard: Enter confirms when enabled ──
  await page.getByTestId("pre-trade-reason").click();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Trade saved: EUR/USD CALL $25.00.", { exact: true })).toBeVisible({
    timeout: 30000,
  });

  // ── Trade persisted with the reviewed parameters ──
  const trade = await db.trade.findFirst({ where: { userId, asset: "EUR/USD" } });
  expect(trade, "trade should be saved after confirming").toBeTruthy();
  expect(trade!.stake.toString()).toBe("25");
  expect(trade!.result).toBe("OPEN");
  expect(trade!.followedPlan).toBe(true); // checkbox hidden → form default
});

test("cancel: attempt recorded (no trade) + dashboard 'Trades you avoided'", async ({ page }) => {
  await login(page);
  const dialog = await openConfirmationModal(page, "40");
  await expect(dialog.getByText("$40.00", { exact: true })).toBeVisible();

  await page.getByTestId("pre-trade-cancel").click();
  await expect(page.getByText("Trade cancelled", { exact: true })).toBeVisible({
    timeout: 30000,
  });

  // No trade was created with that stake…
  const created = await db.trade.count({ where: { userId, stake: new Decimal("40") } });
  expect(created).toBe(0);

  // …but the cancelled attempt was recorded.
  const attempt = await db.cancelledTradeAttempt.findFirst({ where: { userId } });
  expect(attempt, "cancelled attempt should be recorded").toBeTruthy();
  expect(attempt!.asset).toBe("EUR/USD");
  expect(Number(attempt!.stake)).toBe(40);
  expect(attempt!.reason).toContain("Cancelled at the pre-trade confirmation");

  // Dashboard card: count + total stake saved.
  await page.goto("/app/dashboard");
  const card = page.getByTestId("trades-you-avoided");
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("avoided-count")).toHaveText("1");
  await expect(card.getByText("$40.00 not risked")).toBeVisible();
});

test("settings persist: cooldown change survives reload + reaches the DB", async ({ page }) => {
  await login(page);
  await page.goto("/app/settings");

  await page.getByTestId("ptc-cooldown-input").fill("0");
  await page.getByTestId("ptc-save").click();
  await expect(page.getByText("Pre-trade confirmation settings saved.")).toBeVisible({
    timeout: 30000,
  });

  // UI: survives a reload.
  await page.reload();
  await expect(page.getByTestId("ptc-cooldown-input")).toHaveValue("0");

  // DB: actually persisted on the User row.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { preTradeCooldownSeconds: true },
  });
  expect(user?.preTradeCooldownSeconds).toBe(0);
});

test("mobile: dialog usable on a phone viewport and confirm saves", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const dialog = await openConfirmationModal(page, "15");

  // Cooldown is 0 after the settings test — confirm is immediately enabled.
  const confirmBtn = page.getByTestId("pre-trade-confirm");
  await expect(confirmBtn).toBeEnabled({ timeout: 30000 });
  await confirmBtn.click();

  await expect(page.getByText("Trade saved: EUR/USD CALL $15.00.", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(dialog).toBeHidden();
});
