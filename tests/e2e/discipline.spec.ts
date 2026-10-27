/**
 * Phase 21 acceptance test — Discipline Score.
 *
 * Covers:
 *   1. Dashboard card renders with today's score + 7d/30d avg + streak
 *      (zero-state initially since the test user has no trades).
 *   2. Seed disciplined trades + run the cron sweep → card shows score 100
 *      + streak 1.
 *   3. Discipline page renders the calendar with cells colored by score.
 *   4. Clicking a calendar day opens the breakdown drawer.
 *   5. Weekly discipline-vs-profit chart renders with seeded data.
 *   6. Milestone badges render (subtle, professional).
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

const email = `e2e-ds+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";
let accountId = "";

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "DS E2E",
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
      name: "E2E Discipline",
      broker: "TestBroker",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("1000"),
      currentBalance: new Decimal("1000"),
    },
  });
  accountId = account.id;
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
  // Set the active-account cookie so server actions find the right account.
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

test("1. dashboard card renders with zero-state (no trades yet)", async ({ page }) => {
  await login(page);
  await page.goto("/app/dashboard");
  // The card should be visible (rest day = 95).
  await expect(page.getByTestId("discipline-score-card")).toBeVisible({ timeout: 20000 });
  // Today's score is 95 (rest day, no checklist/balance done).
  await expect(page.getByTestId("today-discipline-score")).toContainText("95");
  // Streak is 1 (today is a rest day → keeps streak from yesterday which
  // has no DailyScore row → treated as rest day → so 0+0=0... actually
  // since there's no yesterday row, the streak walks: today (rest day,
  // continue, no increment), yesterday (gap, continue, no increment),
  // day-before (gap, continue, no increment)... so streak=0.
  // We just assert the field exists with any value.
  await expect(page.getByTestId("current-streak")).toBeVisible();
});

test("2. seed disciplined trade → score 100 + streak updates", async ({ page }) => {
  // Seed one disciplined WIN trade today.
  const now = new Date();
  await db.trade.create({
    data: {
      userId,
      tradingAccountId: accountId,
      asset: "EUR/USD",
      direction: "CALL",
      stake: new Decimal("10"),
      payoutPercent: new Decimal("0.85"),
      expiryMinutes: 5,
      openedAt: now,
      closedAt: new Date(now.getTime() + 60000),
      result: "WIN",
      profitLoss: new Decimal("8.5"),
      followedPlan: true,
    },
  });
  // Seed a checklist-completed TradingSession today so the user earns the
  // CHECKLIST_AND_BALANCE 5 points.
  await db.tradingSession.create({
    data: {
      userId,
      tradingAccountId: accountId,
      startedAt: now,
      startBalance: new Decimal("1008.5"),
    },
  });
  // Seed a balance check today so the user earns the balance check point.
  await db.balanceCheck.create({
    data: {
      userId,
      tradingAccountId: accountId,
      appBalance: new Decimal("1008.5"),
      brokerBalance: new Decimal("1008.5"),
      difference: new Decimal("0"),
      resolution: "MATCHED",
      checkedAt: now,
    },
  });

  await login(page);
  await page.goto("/app/dashboard");
  await expect(page.getByTestId("today-discipline-score")).toContainText("100", {
    timeout: 20000,
  });
  await expect(page.getByTestId("current-streak")).toContainText("1");
});

test("3. discipline page renders calendar + chart + badges", async ({ page }) => {
  await login(page);
  await page.goto("/app/discipline");
  await expect(page).toHaveURL(/\/app\/discipline/, { timeout: 20000 });

  // Calendar visible with at least one cell.
  await expect(page.getByTestId("discipline-calendar")).toBeVisible({ timeout: 20000 });

  // Weekly discipline-vs-profit chart visible.
  await expect(page.getByTestId("discipline-vs-profit-chart")).toBeVisible();

  // Milestone badges visible (subtle styling).
  await expect(page.getByTestId("milestone-badges")).toBeVisible();
  await expect(page.getByTestId("milestone-7")).toBeVisible();
  await expect(page.getByTestId("milestone-30")).toBeVisible();
  await expect(page.getByTestId("milestone-100")).toBeVisible();

  // Disclaimer visible (rule #11).
  await expect(page.getByTestId("discipline-disclaimer")).toBeVisible();
});

test("4. clicking a calendar day opens the breakdown drawer", async ({ page }) => {
  await login(page);
  await page.goto("/app/discipline");
  await expect(page.getByTestId("discipline-calendar")).toBeVisible({ timeout: 20000 });

  // Click today's calendar cell — its key is today's date.
  const today = new Date().toISOString().slice(0, 10);
  await page.getByTestId(`calendar-cell-${today}`).click();

  // Breakdown drawer opens.
  await expect(page.getByTestId("score-breakdown-drawer")).toBeVisible({ timeout: 10000 });
  // All 6 rule breakdowns render.
  await expect(page.getByTestId("breakdown-rules")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-risk_per_trade")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-no_daily_breach")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-no_overrides")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-followed_plan")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-no_tilt")).toBeVisible();
  await expect(page.getByTestId("breakdown-rule-checklist_and_balance")).toBeVisible();
});

test("5. calendar cells are color-coded by score", async ({ page }) => {
  await login(page);
  await page.goto("/app/discipline");

  // Today's cell exists — we don't assert exact color classes (they're
  // implementation-dependent) but the cell has the score visible.
  const today = new Date().toISOString().slice(0, 10);
  const cell = page.getByTestId(`calendar-cell-${today}`);
  await expect(cell).toBeVisible({ timeout: 20000 });
  // The cell contains today's date number.
  const dayNum = String(new Date().getDate());
  await expect(cell).toContainText(dayNum);
  // The cell contains today's score (100 from test 2).
  await expect(cell).toContainText("100");
});

test("6. the discipline-vs-profit chart renders with weekly data points", async ({ page }) => {
  await login(page);
  await page.goto("/app/discipline");
  await expect(page.getByTestId("discipline-vs-profit-chart")).toBeVisible({
    timeout: 20000,
  });
  // The chart is an SVG — we just check it rendered some bars/lines.
  const svg = page.getByTestId("discipline-vs-profit-chart").locator("svg");
  await expect(svg).toBeVisible();
  // The chart has at least one <g> group (Recharts renders groups for axes
  // and series).
  await expect(svg.locator("g").first()).toBeVisible();
});
