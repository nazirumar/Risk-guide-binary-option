import { defineConfig } from "vitest/config";
import path from "node:path";

// NOTE: @vitejs/plugin-react is intentionally NOT included — it's ESM-only
// and vitest's bundled vite is older than what the plugin needs. We'll add a
// separate React test config (or upgrade) when Phase 3+ starts writing
// actual component tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  css: {
    // Silence the @tailwindcss/postcss plugin in unit tests.
    postcss: { plugins: [] },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: [],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
    // Integration tests share one database and their beforeEach wipes the
    // whole DB — running files in parallel makes them delete each other's
    // fixtures mid-test. Keep files sequential.
    fileParallelism: false,
    // Integration tests do full-DB wipes + multi-step recomputes over many
    // Postgres round-trips; the 5s default is too tight for them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      "node_modules",
      ".next",
      "tests/e2e/**",
      "**/*.spec.ts", // exclude Playwright specs from Vitest
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/**", "src/server/**"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    },
  },
});
