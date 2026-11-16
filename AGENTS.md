# AGENTS.md

## Stack & Runtime

- **Framework**: Next.js 16 (App Router), React 19, TypeScript (strict). Tailwind CSS 4 + shadcn/ui (New York). Path alias `@/*` → `src/*`.
- **DB/Auth**: Prisma 6. Schema sets `provider = "postgresql"` by default; `.env.example` shows SQLite path (`file:/home/z/my-project/db/custom.db`). Align provider with `DATABASE_URL` before `db:push/migrate`. Auth.js v4 uses **JWT sessions** (signed cookie, edge-readable, 30-day maxAge) — NOT database sessions, despite the Phase 0 note in `PROJECT_RULES.md`. Middleware runs in the edge runtime and can't reach Prisma, so JWT is required for streaming/static optimization. Password hashing: argon2 with timing-safe dummy-hash verification. Google OAuth uses `AUTH_GOOGLE_*` (legacy `GOOGLE_*` still supported).
- **Money**: All monetary values use `Decimal` (Prisma Decimal). Calculations live in `src/lib/calc/` as pure functions using `decimal.js`. Never use floats for money.
- **Data isolation**: Every DB query must be scoped by `userId` (rule #3). Use `requireUser()` from `src/server/lib/require-user.ts` to get the userId from the session — never from form data.

## Commands (package.json)

- **Dev**: `bun run dev` (port 3000)
- **Build**: `bun run build` — runs `prisma generate && next build && node scripts/copy-standalone.mjs` (copies `static` + `public` into `.next/standalone/`; cross-platform replacement for the old `cp -r` step)
- **Start (prod)**: `NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log` (Docker uses `npx prisma migrate deploy && node server.js`)
- **Lint/Format/Typecheck**: `bun run lint`, `bun run lint:fix`, `bun run format`, `bun run format:check`, `bun run typecheck` (`tsc --noEmit`)
- **Tests**: `bun run test` (Vitest), `bun run test:watch`, `bun run test:coverage`. E2E: `bun run test:e2e`, `bun run test:e2e:ui` (Playwright)
- **DB**: `bun run db:generate`, `bun run db:push` (--accept-data-loss), `bun run db:migrate`, `bun run db:reset`, `bun run db:seed` (uses `bun run prisma/seed.ts`)

## Quality Gates

Run in order when validating changes: `lint` → `typecheck` → `test` (and `build` before shipping). Husky + lint-staged run on commit.

## Important Gotchas

- **Standalone build**: `output: "standalone"`, `typescript.ignoreBuildErrors: true`, `reactStrictMode: false` in `next.config.ts`. Build copies `static` and `public` into `.next/standalone/` — don't skip this custom step.
- **Prisma provider**: `prisma/schema.prisma` uses `postgresql` by default; `.env.example` shows SQLite path (`file:/home/z/my-project/db/custom.db`). Align provider with `DATABASE_URL` before `db:push/migrate`. Schema says "switch to Postgres" by changing provider.
- **Tests split**: Vitest excludes `tests/e2e/**` and `*.spec.ts` (Playwright specs). Coverage focuses on `src/lib/**`, `src/server/**`.
- **ESLint/TS lenient now**: `eslint.config.mjs` disables many strict rules; `tsconfig.json` has `strict: true` but `noImplicitAny: false`. Follow `PROJECT_RULES.md` regardless.
- **Security headers**: Applied globally in `next.config.ts` (HSTS, X-Frame-Options DENY, etc.). Server Actions have sandbox origin allowlist (includes `*.space-z.ai`, `localhost:3000`).
- **Auth model**: JWT sessions (signed cookie, edge-readable, 30-day maxAge) — NOT database sessions, despite the Phase 0 note in `PROJECT_RULES.md`. Middleware runs in the edge runtime and can't reach Prisma, so JWT is required for streaming/static optimization. Google OAuth uses `AUTH_GOOGLE_*` (legacy `GOOGLE_*` still supported).
- **Validation**: Validate all inputs with Zod on the server even if client validates.
- **Demo login**: `demo@riskguard.app` / `riskguard1234` (after seeding).

## Worker

- `worker/` is a **separate Bun process** for market-data ingestion (runs `bun run worker` / `bun run worker:dev`). It has its own `package.json` (only `@prisma/client` dependency) and never runs Next.js code.
- It never exposes provider tokens to the browser. All DB access is via Prisma with respect to provider rate limits.
- The worker backfills 30 days of M5/H1 candles, keeps M1/M5 current, and enforces retention (M1: 7d, M5: 90d, H1/D: 2y).

## Proxy (Next.js 16)

- Next.js 16 renamed `middleware.ts` → `src/proxy.ts`. Do not create `middleware.ts`.
- The proxy protects all `/app/*` and `/onboarding` routes (requires JWT), redirects authed users away from `/login`, `/register`, `/forgot-password`, and enforces the onboarding gate.

## Rate Limiting

- Sign-in routes are rate-limited (10 attempts per 10 minutes per IP+email).
- Register: 5 attempts / 10 min per IP. Forgot password: 5 / 10 min per IP+email. Reset password: 10 / 10 min per IP. Verify email: 10 / 10 min per IP.
- Google sign-in has its own rate limiter (`rateLimitGoogleSignIn` in `src/lib/auth.ts`).
- Production uses Upstash Redis (`UPSTASH_REDIS_REST_URL` / `_TOKEN`); dev falls back to an in-memory limiter.

## Seed & Tests

- `bun run db:seed` runs `prisma/seed.ts` — deterministic (mulberry32 RNG, seed `20261026`), so tests can assert on exact seed output.
- Integration tests share one SQLite DB; `beforeEach` wipes all tables. **Files run sequentially** (`fileParallelism: false`) — parallel files would delete each other's fixtures mid-test.
- Test timeout is 30s (default 5s is too tight for integration tests doing full-DB wipes + multi-step recomputes).
- `@vitejs/plugin-react` is intentionally NOT in Vitest config — it's ESM-only and incompatible with Vitest's bundled vite. Component tests are not yet written.
- E2E tests use Playwright; `bun run test:e2e` auto-starts the dev server. Use a fresh random email per run for idempotency.

## Phase Status

- All phases 0–29 are complete except **Phase 25 (Google OAuth & account linking)**, which is `[ ]` in `PROGRESS.md`.
- Revised re-run of phases 26–29 (against the revised spec: no OANDA, Deriv public no-auth WebSocket + TwelveData fallback) is also `[ ]`.
- Do not start the next phase until explicitly told. Run `lint` → `typecheck` → `test` → `build` before considering a phase done.

## Structure (key)

- `src/app/` (App Router), `src/components/` (shadcn/ui in `components/ui`), `src/lib/` (pure utils/calc/format), `src/server/` (server-only actions/lib), `src/hooks/`, `src/types/`
- `prisma/` schema/migrations/seed. `tests/` unit/integration + `tests/e2e/`. `docs/` (ERD.md, FORMULAS.md). `PROJECT_RULES.md` is permanent.
- `worker/` — separate Bun process for market data ingestion (own `package.json`, only `@prisma/client`).
- `scripts/` — `copy-standalone.mjs` (build step), `generate-icons.mjs`, `verify-seed.ts`, `sse-load-test.mjs`.

## References

- `PROJECT_RULES.md` — permanent rules (money as Decimal, user scoping, phases, disclaimer)
- `README.md` — setup/deploy details (SQLite vs Postgres, Docker, Vercel)
- `PROGRESS.md` — phase tracker
- `TESTING.md`, `SECURITY.md`, `ARCHITECTURE.md`
