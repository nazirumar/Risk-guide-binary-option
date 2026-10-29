/**
 * Phase 28 acceptance test — Live market conditions dashboard.
 *
 * Covers:
 *   1. Cards render (pair + disclaimer + score bar) for a signed-in user.
 *   2. "Show only GOOD" filter narrows the card list.
 *   3. Clicking a card opens the drawer with the factor breakdown.
 *   4. Simulated outage → the banner shows and ratings go grey (no badge).
 *
 * Setup uses the DB directly (same pattern as sessions-news.spec.ts). We seed
 * instruments + `MarketCondition` rows rather than waiting on the worker, so
 * the page has deterministic content. One GOOD and one AVOID pair.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });

const email = `e2e-mkt+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";
let userId = "";

const factors = [
  {
    key: "volatility",
    label: "Volatility",
    score: 80,
    weight: 35,
    note: "Typical range.",
    percentile: 52,
  },
  { key: "trend", label: "Trend", score: 70, weight: 20, note: "Trending." },
  { key: "spread", label: "Spread", score: 90, weight: 20, note: "Tight." },
  { key: "session", label: "Session", score: 85, weight: 15, note: "London open." },
  { key: "news", label: "News", score: 100, weight: 10, note: "No events soon." },
];

async function upsertPair(symbol: string, rating: string, score: number) {
  const instrument = await db.instrument.upsert({
    where: { symbol },
    update: { isActive: true },
    create: {
      symbol,
      base: symbol.slice(0, 3),
      quote: symbol.slice(4),
      pipSize: 0.0001,
      isActive: true,
      isMajor: true,
    },
  });
  const computedAt = new Date();
  await db.marketCondition.upsert({
    where: { instrumentId: instrument.id },
    update: {
      score,
      rating,
      factors,
      reasons: [`Conditions are ${rating.toLowerCase()}.`],
      computedAt,
    },
    create: {
      instrumentId: instrument.id,
      score,
      rating,
      factors,
      reasons: [`Conditions are ${rating.toLowerCase()}.`],
      computedAt,
    },
  });
  return instrument.id;
}

test.beforeAll(async () => {
  // Neon's pooler can be slow to wake — retry the initial connect a few times
  // so a transient "Can't reach database server" doesn't abort the whole suite.
  let connected = false;
  for (let attempt = 1; attempt <= 4 && !connected; attempt++) {
    try {
      await db.$connect();
      connected = true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!connected) throw new Error("Could not connect to the database");

  // Pre-compile the routes the tests hit. `next dev` compiles on first request;
  // a cold compile of the app shell blows past the login navigation timeout.
  for (const path of [
    "/login",
    "/",
    "/app/dashboard",
    "/app/market",
    "/api/auth/csrf",
    "/api/auth/callback/credentials",
    "/api/market/stream",
  ]) {
    await fetch(`http://localhost:3000${path}`).catch(() => {});
  }

  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: "MKT E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
  userId = user.id;

  await upsertPair("EUR_USD", "GOOD", 82);
  await upsertPair("GBP_JPY", "AVOID", 22);
});

test.afterAll(async () => {
  const symbols = ["EUR_USD", "GBP_JPY"];
  for (const symbol of symbols) {
    const inst = await db.instrument.findUnique({ where: { symbol }, select: { id: true } });
    if (inst) await db.marketCondition.deleteMany({ where: { instrumentId: inst.id } });
  }
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

async function login(page: Page) {
  test.setTimeout(120_000); // first hit can trigger a dev compile
  // `next dev` compiles /app/* on the first AUTHED request (the proxy shields
  // them from unauthenticated warm-up fetches) — give navigations room.
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(15_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test("1. cards render with score bars and the persistent disclaimer", async ({ page }) => {
  await login(page);
  await page.goto("/app/market");
  await expect(page.getByRole("heading", { name: /market conditions/i })).toBeVisible();
  const cards = page.getByTestId("pair-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("market-disclaimer")).toContainText(/not a trading signal/i);
  await expect(page.getByTestId("score-bar-fill").first()).toBeVisible();
});

test("2. 'Show only GOOD' filter narrows the list to GOOD pairs", async ({ page }) => {
  await login(page);
  await page.goto("/app/market");
  await expect(page.getByTestId("pair-card")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Show only GOOD" }).click();
  await expect(page.getByTestId("pair-card")).toHaveCount(1);
  await expect(page.getByTestId("pair-card")).toHaveAttribute("data-pair", "EUR_USD");
});

test("3. clicking a card opens the drawer with the factor breakdown", async ({ page }) => {
  await login(page);
  await page.goto("/app/market");
  await page.getByTestId("pair-card").first().click();
  await expect(page.getByTestId("drawer-title")).toBeVisible();
  await expect(page.getByTestId("factor-volatility")).toBeVisible();
  await expect(page.getByTestId("factor-news")).toBeVisible();
});

test("5. cards update live via SSE without a page refresh", async ({ page }) => {
  await login(page);
  await page.goto("/app/market");

  const card = page.locator("[data-testid='pair-card'][data-pair='EUR_USD']");
  await expect(card).toBeVisible();

  // Mutate the shared row in the DB — as the worker would — and assert the
  // CLIENT picks it up over SSE (no reload).
  const inst = await db.instrument.findUnique({
    where: { symbol: "EUR_USD" },
    select: { id: true },
  });
  if (!inst) throw new Error("EUR_USD instrument missing");
  await db.marketCondition.update({
    where: { instrumentId: inst.id },
    data: {
      score: 97,
      rating: "GOOD",
      factors,
      reasons: ["Fresh from the live stream."],
      computedAt: new Date(),
    },
  });

  await expect(card).toContainText("97", { timeout: 30_000 }); // SSE push ≤ ~15 s
  await expect(card).toContainText("Fresh from the live stream.", { timeout: 5_000 });
  // No navigation occurred — we stayed on the same document.
  expect(page.url()).toContain("/app/market");
});

test("4. simulated outage shows the banner and greys out ratings", async ({ page }) => {
  await login(page);
  // Backdate every condition's computedAt so the snapshot reads as stale (>3m).
  await db.marketCondition.updateMany({
    data: { computedAt: new Date(Date.now() - 10 * 60 * 1000) },
  });
  try {
    await page.goto("/app/market");
    await expect(page.getByTestId("outage-banner")).toBeVisible();
    await expect(page.getByTestId("outage-banner")).toContainText(/do not rely on ratings/i);
    // Ratings are greyed: badge is the muted "—" placeholder, not GOOD/AVOID.
    await expect(page.getByTestId("rating-badge")).toHaveCount(0);
  } finally {
    // Restore fresh rows so a re-run isn't stuck in the outage state.
    await db.marketCondition.updateMany({ data: { computedAt: new Date() } });
  }
});
