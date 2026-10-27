import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const db = new PrismaClient();

/**
 * Phase 2 acceptance test: register → verify-email → login → onboarding →
 * /app/dashboard, with the protected-route enforcement check at the end.
 *
 * Uses a fresh random email per run so the test is idempotent.
 */
test.describe("Phase 2 auth flow", () => {
  const email = `e2e+${randomBytes(4).toString("hex")}@example.com`;
  const password = "TestPass123!";

  // Cleanup before each test in case the previous run left rows behind.
  test.beforeAll(async () => {
    await db.auditLog.deleteMany({});
    await db.notification.deleteMany({});
    await db.trade.deleteMany({});
    await db.transaction.deleteMany({});
    await db.riskProfile.deleteMany({});
    await db.tradingAccount.deleteMany({});
    await db.passwordReset.deleteMany({});
    await db.verificationToken.deleteMany({
      where: { identifier: email },
    });
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
  });

  test("register → verify email → login → onboarding → dashboard", async ({ page }) => {
    // 1. Register
    await page.goto("/register");
    await page.getByLabel("Name").fill("E2E Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page
      .getByRole("checkbox", {
        name: /binary options are high risk/i,
      })
      .check();
    await page.getByRole("button", { name: "Create account" }).click();

    // Should land on /verify-email?email=…
    await expect(page).toHaveURL(/\/verify-email/);

    // 2. Grab the verification token from the DB (dev email fallback is the
    //    server console, which Playwright can't read; instead we read the
    //    token directly from the VerificationToken table).
    const token = await db.verificationToken.findFirst({
      where: { identifier: email },
      orderBy: { createdAt: "desc" },
    });
    expect(token, "verification token should exist after register").toBeTruthy();

    // 3. Verify email by visiting the link directly.
    await page.goto(`/verify-email?token=${token!.token}`);
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByText(/Email verified/i)).toBeVisible();

    // 4. Log in.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // 5. Should land on /onboarding because user is verified but not onboarded.
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: /Welcome to RiskGuard/i })).toBeVisible();

    // 6. Fill the onboarding wizard (single-page form).
    await page.getByLabel("Broker").fill("Quotex");
    await page.getByRole("button", { name: /Finish & enter RiskGuard/i }).click();

    // 7. Should land on /app/dashboard with the seeded stats showing.
    // Use a generous timeout — onboarding completion + JWT refresh + push
    // can take >5s on a cold dev server.
    await expect(page).toHaveURL(/\/app\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 30_000,
    });
    // The dashboard renders either the "Equity curve" panel (when the user
    // has at least one account + trades) or the empty-state CTA. Either way,
    // the sidebar nav is visible — assert a known nav label as a proxy for
    // "the dashboard shell rendered".
    await expect(page.getByRole("link", { name: "Trades" }).first()).toBeVisible({
      timeout: 30_000,
    });

    // 8. Verify DB state — onboarding flag flipped, account + risk profile created.
    await db.$connect();
    const user = await db.user.findUnique({
      where: { email },
      select: {
        isOnboarded: true,
        emailVerified: true,
        timezone: true,
        baseCurrency: true,
      },
    });
    expect(user?.isOnboarded).toBe(true);
    expect(user?.emailVerified).not.toBeNull();
    const accounts = await db.tradingAccount.findMany({
      where: { userId: (await db.user.findUnique({ where: { email } }))!.id },
    });
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    const profiles = await db.riskProfile.findMany({
      where: { userId: (await db.user.findUnique({ where: { email } }))!.id },
    });
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles[0].maxConsecutiveLosses).toBe(3);
  });

  test("unauthenticated users cannot reach /app/*", async ({ page }) => {
    // Clear all cookies to ensure we're unauthenticated.
    await page.context().clearCookies();
    await page.goto("/app/dashboard");
    // Should be redirected to /login by the middleware.
    await expect(page).toHaveURL(/\/login/);
  });
});
