# AGENTS.md

## Stack & runtime traps

- Next.js 16 App Router + React 19 + TypeScript (`strict: true`, `noImplicitAny: false`), Tailwind 4 + shadcn/ui; alias `@/*` → `src/*`. Use Bun.
- Prisma 6 datasource is `postgresql` and the live `.env` points at hosted Neon. README, `.env.example`, `PROJECT_RULES.md` and old phases still say SQLite — ignore those claims. `prisma/migrations/migration_lock.toml` says `sqlite`, so `db:migrate` / `migrate deploy` hits P3019; schema changes are pushed with `bun run db:push` (as phases 26–29 did).
- Auth.js v4 uses **JWT** sessions (30-day signed cookie), not database sessions — the edge proxy can't reach Prisma. `User.sessionVersion` invalidates stale JWTs on next check (~60s). Google OAuth env vars are `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`; legacy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` still work.
- Money = Prisma `Decimal` + pure functions in `src/lib/calc` (`decimal.js`), never floats. Validate all input with Zod on the server. Scope every query by `userId` from `requireUser()` (`src/server/lib/require-user.ts`), never from form data.
- `src/proxy.ts` is the Next.js 16 replacement for `middleware.ts` — do not create `middleware.ts`. It guards `/app/*` and `/onboarding`, redirects authed users off `/login|/register|/forgot-password`, and enforces the onboarding gate.
- Next.js 16 dynamic APIs are async: `await cookies()`, `await headers()`, `await searchParams`.
- `next.config.ts` sets `output: "standalone"`, `typescript.ignoreBuildErrors: true` (so **you** must run `typecheck`), `reactStrictMode: false`, global security headers, and a Server Actions origin allowlist (`*.space-z.ai`, `*.fcapp.run`, `localhost:3000`).

## Commands

- Dev: `bun run dev` (port 3000). Prod: `bun run build` then `bun run start`; the build's final `scripts/copy-standalone.mjs` step copies `.next/static` + `public` into `.next/standalone/` — don't skip it.
- Checks: `bun run lint`, `bun run lint:fix`, `bun run format`, `bun run format:check`, `bun run typecheck`. Lint takes several minutes here — don't assume it hung.
- Tests: `bun run test`; single file `bun run test tests/<name>.test.ts`; also `test:watch`, `test:coverage`, `test:e2e`, `test:e2e:ui`. Playwright auto-starts the dev server; install its browser once with `bunx playwright install chromium` if missing.
- DB: `bun run db:generate`, `db:push`, `db:reset`, `db:seed`. Prefer `db:push` over migrations (see P3019 above).
- Worker: `bun run worker` / `bun run worker:dev` (both `cd worker` first). Icons: `bun run icons`.

## Quality gates / CI

- Run in order: `lint` → `typecheck` → `test` → `build`. CI (`.github/workflows/ci.yml`) does the same with Bun; its test step has **no** `DATABASE_URL` or DB service, so CI won't catch DB-integration regressions.
- Husky pre-commit runs lint-staged (`eslint --fix` + `prettier --write` on staged files).
- PowerShell gotcha: piping native stderr (`2>&1`) can raise a spurious `NativeCommandError` and mask the real exit code. Use `cmd /c "bun run lint > lint.log 2>&1"`, then check `$LASTEXITCODE`.

## Tests

- Integration tests use their own `PrismaClient` against the DB in `.env` (remote Neon, not SQLite) and wipe **all** tables in `beforeEach`. `fileParallelism: false` in `vitest.config.ts` is load-bearing; 30s test/hook timeouts are intentional. Never point `DATABASE_URL` at a database whose data you need.
- Documented baseline: 836 passed / 172 failed (1008) at phase 29. The 172 are pre-existing `Subscription_userId_fkey` RESTRICT teardown failures across 11 integration files — compare before blaming your change.
- `bun run db:seed` is deterministic (mulberry32, seed `20261026`); demo login `demo@riskguard.app` / `riskguard1234`.
- Vitest excludes `tests/e2e/**` and `*.spec.ts`; coverage targets `src/lib/**` + `src/server/**`. No React plugin and empty `setupFiles` — component tests are not wired up. E2E uses a fresh random email per run for idempotency.

## Market worker

- `worker/` is a separate Bun process with its own `package.json` (only `@prisma/client`). It reuses pure modules via relative imports from `src/lib/market/**` and `src/server/lib/notification-types.ts` — keep Next-only/runtime imports out of those modules or the worker breaks. Never expose provider tokens to the browser.
- The web path never constructs a market provider; it reads precomputed `MarketCondition` / `MarketDataStatus` rows. Worker backfills 30 days of M5/H1, keeps M1/M5 current, and retains M1 7d / M5 90d / H1-D 2y.
- `MARKET_PROVIDER=deriv` default (public no-auth WebSocket); TwelveData is a rate-limited REST fallback (8/min, 800/day). OANDA is not used. Env knobs are documented in `.env.example`.
- Phase 30.1 news agent also lives only in `worker/src/news-agent.ts` (off unless `NEWS_AGENT_ENABLED=true`). Pure helpers in `src/lib/news/{sources,extract,dedupe,classify}.ts`; scraped text is untrusted data and only allowlisted domains may be fetched. Web reads `NewsArticle`/`NewsEvent` rows; never fetch pages from a request path.
- Phase 30.2 coach is opt-in (`User.aiCoachEnabled`, default false) with a separate `coachIncludeNotes` toggle; quota is `COACH_MAX_MESSAGES_PER_DAY` (default 20) plus a 12/10m burst limit. Pure safety/prompt logic is `src/lib/ai/coach.ts`; actions in `src/server/actions/coach.ts`. Every assistant reply stores `sharedContext` for the "What data was shared" disclosure and ends with the risk disclaimer. Never select email/name/screenshots into the AI context.

## Phase rules & references

- `PROGRESS.md` is the phase tracker: don't redo finished phases and don't start the next one without explicit instruction (`PROJECT_RULES.md` rule #10). Tracker is stale in spots — Phase 25 is boxed unchecked despite OAuth code/tests/docs existing; phases 26–29 are checked from the first pass while the revised 26–29 boxes are unchecked and "current phase: 26 (revised)". Verify code before assuming a phase is unimplemented.
- Permanent rules in `PROJECT_RULES.md`: visible risk disclaimer, no TODOs/mock data in finished features, martingale staking OFF by default with a red warning.
- Pre-tuned rate-limit helpers live in `src/lib/rate-limit.ts` — use them (login 10, register 5, forgot 5, reset 10, verify 10, Google sign-in 10, sign-out-all/unlink 5 per 10 min); Upstash in prod, in-memory fallback in dev.
- Docs that lie (trust code/config): `README.md` (SQLite, "371 tests", "14 phases"), `TESTING.md` (Vitest 3/SQLite/371 tests), `PROJECT_RULES.md` (DB sessions, `/home/z/my-project` paths).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
