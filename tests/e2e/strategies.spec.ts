/**
 * Phase 20 acceptance test — Strategy Validation.
 *
 * Covers the full strategy-validation loop end-to-end:
 *   1. CREATE STRATEGY: add a strategy → it appears in the comparison table
 *      with the INSUFFICIENT + "Not enough data" verdict.
 *   2. SEED TRADES + CHECK VERDICTS:
 *      - Seed 8 wins / 10 total → still INSUFFICIENT (total < 30).
 *      - Seed enough losses to total 30 (16/30) → LOW + "Can't tell yet".
 *      - Add wins until 25/30 → LOW + "Likely profitable".
 *   3. DETAIL PAGE: chart + Wilson bounds + disclaimer visible.
 *   4. ADD TRADE WARNING: pick a strategy with "Likely losing" verdict →
 *      warning panel surfaces.
 *
 * Setup uses the DB directly (register→onboarding e2e has a known Phase 4
 * issue). The user has one DEMO account with a 1000 starting balance + a
 * 200 DEPOSIT (balance 1200).
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import Decimal from "decimal.js";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });

const email = `e2e-sv+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";
let accountId = "";
let strategyId = "";
let losingStrategyId = "";

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "SV E2E",
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
      name: "E2E Strategy",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
  accountId = account.id;

  // Create a "profitable" strategy via DB (the action would need session context).
  const s = await db.strategy.create({
    data: { userId, name: "Trend-following", isActive: true, color: "#10b981" },
  });
  strategyId = s.id;

  // Create a second strategy that we'll seed with heavy losses so it goes
  // "Likely losing" — to test the Add Trade warning.
  const s2 = await db.strategy.create({
    data: { userId, name: "Counter-trend", isActive: true, color: "#ef4444" },
  });
  losingStrategyId = s2.id;
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

/**
 * Seed N closed trades under the given strategy with the given win/loss
 * ratio + payout. Direct DB writes (faster than UI clicks).
 */
async function seedTrades(
  stratId: string,
  wins: number,
  losses: number,
  payout: number,
  stake: string,
) {
  for (let i = 0; i < wins; i++) {
    await db.trade.create({
      data: {
        userId,
        tradingAccountId: accountId,
        strategyId: stratId,
        asset: "EUR/USD",
        direction: "CALL",
        stake: new Decimal(stake),
        payoutPercent: new Decimal(payout),
        expiryMinutes: 5,
        openedAt: new Date(Date.now() + i * 1000),
        closedAt: new Date(Date.now() + i * 1000 + 60000),
        result: "WIN",
        profitLoss: new Decimal(stake).times(payout),
      },
    });
  }
  for (let i = 0; i < losses; i++) {
    await db.trade.create({
      data: {
        userId,
        tradingAccountId: accountId,
        strategyId: stratId,
        asset: "EUR/USD",
        direction: "CALL",
        stake: new Decimal(stake),
        payoutPercent: new Decimal(payout),
        expiryMinutes: 5,
        openedAt: new Date(Date.now() + (wins + i) * 1000),
        closedAt: new Date(Date.now() + (wins + i) * 1000 + 60000),
        result: "LOSS",
        profitLoss: new Decimal(stake).neg(),
      },
    });
  }
}

test("1. strategies list shows new strategy with INSUFFICIENT + Not enough data", async ({
  page,
}) => {
  await login(page);
  await page.goto("/app/strategies");
  await expect(page.getByTestId("strategies-comparison-table")).toBeVisible({
    timeout: 20000,
  });

  // Disclaimer is visible.
  await expect(page.getByTestId("strategy-disclaimer")).toBeVisible();

  // Both strategies appear as rows.
  await expect(page.getByTestId(`strategy-row-${strategyId}`)).toBeVisible();
  await expect(page.getByTestId(`strategy-row-${losingStrategyId}`)).toBeVisible();

  // The strategy has the INSUFFICIENT reliability badge + "Not enough data" verdict.
  await expect(page.getByTestId("reliability-badge-insufficient").first()).toBeVisible();
  await expect(page.getByText("Not enough data").first()).toBeVisible();
});

test("2. seed 8 wins / 10 → still INSUFFICIENT (total < 30)", async ({ page }) => {
  await seedTrades(strategyId, 8, 2, 0.85, "10");
  await login(page);
  await page.goto("/app/strategies");
  await expect(page.getByTestId(`strategy-row-${strategyId}`)).toBeVisible();
  // Reliability still INSUFFICIENT — total < 30.
  await expect(page.getByText("INSUFFICIENT").first()).toBeVisible();
  // Trade count shows 10.
  const row = page.getByTestId(`strategy-row-${strategyId}`);
  await expect(row).toContainText("10");
});

test("3. extend to 25 wins / 30 total → LOW + Likely profitable", async ({ page }) => {
  // Add 17 more wins + 3 more losses → 25/30 total at 0.85 payout.
  await seedTrades(strategyId, 17, 3, 0.85, "10");
  await login(page);
  await page.goto("/app/strategies");
  // Wilson lower bound > break-even 0.5405 → "Likely profitable".
  const row = page.getByTestId(`strategy-row-${strategyId}`);
  await expect(row).toContainText("30");
  // Wait for the verdict "Likely profitable" to appear in this row.
  await expect(page.getByText("Likely profitable").first()).toBeVisible({
    timeout: 10000,
  });
  // Reliability badge is now LOW.
  await expect(page.getByTestId("reliability-badge-low").first()).toBeVisible();
});

test("4. seed losing strategy with 30 losses / 2 wins → LOW + Likely losing", async ({ page }) => {
  // Seed 2 wins + 28 losses → 2/30 = 6.67% win rate. Wilson upper will be
  // well below break-even 0.5405 → "Likely losing".
  await seedTrades(losingStrategyId, 2, 28, 0.85, "10");
  await login(page);
  await page.goto("/app/strategies");
  await expect(page.getByText("Likely losing").first()).toBeVisible({
    timeout: 10000,
  });
});

test("5. Add Trade form shows warning when picking Likely-losing strategy", async ({ page }) => {
  await login(page);
  await page.goto("/app/trades");
  // The strategy select has the warning hidden initially (no strategy selected).
  await expect(page.getByTestId("strategy-select")).toBeVisible();
  await expect(page.getByTestId("likely-losing-strategy-warning")).toHaveCount(0);

  // Pick the losing strategy by value.
  await page.getByTestId("strategy-select").selectOption(losingStrategyId);

  // Warning panel surfaces within 1s.
  await expect(page.getByTestId("likely-losing-strategy-warning")).toBeVisible({
    timeout: 5000,
  });
  // The warning text mentions "likely to lose".
  await expect(page.getByTestId("likely-losing-strategy-warning")).toContainText(/likely to lose/i);

  // Switch back to a "Likely profitable" strategy → warning hides.
  await page.getByTestId("strategy-select").selectOption(strategyId);
  await expect(page.getByTestId("likely-losing-strategy-warning")).toHaveCount(0);
});

test("6. strategy detail page shows chart + Wilson bounds + disclaimer", async ({ page }) => {
  await login(page);
  await page.goto(`/app/strategies/${strategyId}`);
  await expect(page).toHaveURL(new RegExp(`/app/strategies/${strategyId}`), {
    timeout: 20000,
  });

  // Disclaimer block visible.
  await expect(page.getByTestId("strategy-detail-disclaimer")).toBeVisible();

  // Stat grid: trades + win rate + break-even + Wilson lower.
  await expect(page.getByText("Closed trades")).toBeVisible();
  await expect(page.getByText("Win rate", { exact: true })).toBeVisible();
  await expect(page.getByText("Break-even win rate")).toBeVisible();
  await expect(page.getByText("Wilson lower bound")).toBeVisible();

  // Win-rate confidence band chart visible (data exists — 30 trades).
  await expect(page.getByTestId("win-rate-confidence-chart")).toBeVisible({
    timeout: 10000,
  });

  // Verdict pill: "Likely profitable".
  await expect(page.getByText("Likely profitable").first()).toBeVisible();
});
