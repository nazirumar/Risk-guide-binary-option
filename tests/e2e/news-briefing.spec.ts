/**
 * Phase 30.1 acceptance test — AI news briefing panel.
 *
 * Seeds one NewsArticle row directly (the worker writes these in production),
 * then verifies /app/news renders the briefing section and the article. Uses
 * a fresh random email so re-runs are idempotent. No provider keys needed.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });
// /app/news performs a provider refresh + two DB reads on first render;
// the remote Neon DB can be slow, so give this spec a generous budget.
test.setTimeout(120_000);

const suffix = randomBytes(4).toString("hex");
const email = `e2e-news30-${suffix}@example.com`;
const password = "TestPass123!";
const source = `e2e-fed-${suffix}`;
const articleUrl = `https://www.federalreserve.gov/newsevents/pressreleases/monetary${suffix}.htm`;
const title = `FOMC holds target range steady (${suffix})`;

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });

  await db.user.create({
    data: {
      email,
      name: "News Briefing E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });

  await db.newsArticle.create({
    data: {
      source,
      url: articleUrl,
      contentHash: `e2e-${suffix}`,
      title,
      summary: "The committee left rates unchanged and gave no forward guidance.",
      publishedAt: new Date(),
      currency: ["USD"],
      symbols: [],
      impact: "HIGH",
    },
  });
});

test.afterAll(async () => {
  await db.newsArticle.deleteMany({ where: { source } });
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

test("news page renders the AI briefing and the seeded article", async ({ page }) => {
  await login(page);
  await page.goto("/app/news", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page).toHaveURL(/\/app\/news/, { timeout: 20000 });

  await expect(page.getByTestId("news-disclaimer")).toBeVisible();
  await expect(page.getByTestId("news-briefing")).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText("HIGH impact")).toBeVisible();
});
