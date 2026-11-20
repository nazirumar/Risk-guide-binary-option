/**
 * Phase 30.2 acceptance test — opt-in AI journal coach panel.
 *
 * Seeds one opted-in user directly (no AI key needed: the action falls back
 * to the deterministic rule-based reply), logs in, asks a question on
 * /app/reports and verifies the reply, the disclosure and the disclaimer.
 * Uses a fresh random email so re-runs are idempotent.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const db = new PrismaClient();

test.describe.configure({ mode: "serial" });
// Reports runs analytics + several DB reads against the remote Neon DB.
test.setTimeout(360_000);

const suffix = randomBytes(4).toString("hex");
const email = `e2e-coach30-${suffix}@example.com`;
const password = "TestPass123!";

test.beforeAll(async () => {
  await db.$connect();
  await db.user.deleteMany({ where: { email } });
  await db.user.create({
    data: {
      email,
      name: "Coach E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
      aiCoachEnabled: true,
      coachIncludeNotes: false,
    },
  });
});

test.afterAll(async () => {
  await db.coachMessage.deleteMany();
  await db.coachConversation.deleteMany();
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

async function login(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 90_000 });
    // The login form is a client component. On a cold dev server React may not
    // have hydrated yet: filling before hydration gets wiped when React writes
    // its empty state back into the controlled inputs, and clicking submits a
    // native GET. Wait for React's internal props on the form before filling.
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

test("opted-in user can ask the coach and sees the disclosure + disclaimer", async ({ page }) => {
  await login(page);
  await page.goto("/app/reports", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await expect(page).toHaveURL(/\/app\/reports/, { timeout: 30_000 });

  const panel = page.getByTestId("coach-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId("coach-quota")).toContainText("of 20 reflections left today");
  await expect(panel.getByTestId("coach-disclaimer")).toContainText("not financial advice");

  await page.getByTestId("coach-input").fill("What does my journal say about consistency?");
  await page.getByTestId("coach-send").click();

  await expect(page.getByTestId("coach-message-user")).toContainText("consistency", {
    timeout: 60_000,
  });
  const reply = page.getByTestId("coach-message-assistant");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).toContainText("past results don't guarantee future outcomes");
  await expect(reply.getByText("What data was shared")).toBeVisible();

  // The DB row proves the action persisted the reply, not just optimistic UI.
  const stored = await db.coachMessage.findFirst({ where: { role: "assistant" } });
  expect(stored).not.toBeNull();
  expect(stored?.content).toContain("past results don't guarantee future outcomes");
  expect(stored?.sharedContext).not.toBeNull();
});
