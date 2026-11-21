import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for RiskGuard end-to-end tests.
 *
 * NOTE: Phase 0 only configures the runner. Actual e2e specs arrive with
 * later phases (see PROGRESS.md). Run `bun run test:e2e` to execute.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html"], ["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    // Slow/filesystem-bound CI sandboxes can take longer than 2 min to boot
    // the Next dev server; override without changing the checked-in default.
    timeout: Number(process.env.E2E_WEBSERVER_TIMEOUT ?? 120_000),
  },
});
