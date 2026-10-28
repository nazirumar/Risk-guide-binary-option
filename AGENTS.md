# AGENTS.md

## Stack & Runtime

- **Framework**: Next.js 16 (App Router), React 19, TypeScript (strict). Tailwind CSS 4 + shadcn/ui (New York). Path alias `@/*` → `src/*`.
- **DB/Auth**: Prisma 6. Schema currently sets `datasource db { provider = "postgresql" }` but sandbox/dev commonly uses SQLite; switch provider + `DATABASE_URL` as needed. Auth.js v4 (JWT + argon2 + Google OAuth). See `PROJECT_RULES.md`.
- **Money**: All monetary values use `Decimal` (Prisma Decimal). Calculations live in `src/lib/calc/` as pure functions using `decimal.js`. Never use floats for money.
- **Data isolation**: Every DB query must be scoped by `userId` (rule #3).

## Commands (package.json)

- **Dev**: `bun run dev` (port 3000)
- **Build**: `bun run build` — runs `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/` (required for standalone output)
- **Start (prod)**: `NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log` (Docker uses `npx prisma migrate deploy && node server.js`)
- **Lint/Format/Typecheck**: `bun run lint`, `bun run lint:fix`, `bun run format`, `bun run format:check`, `bun run typecheck` (`tsc --noEmit`)
- **Tests**: `bun run test` (Vitest), `bun run test:watch`, `bun run test:coverage`. E2E: `bun run test:e2e`, `bun run test:e2e:ui` (Playwright)
- **DB**: `bun run db:generate`, `bun run db:push` (--accept-data-loss), `bun run db:migrate`, `bun run db:reset`, `bun run db:seed` (uses `bun run prisma/seed.ts`)

## Quality Gates

Run in order when validating changes: `lint` → `typecheck` → `test` (and `build` before shipping). Husky + lint-staged run on commit.

## Important Gotchas

- **Standalone build**: `output: "standalone"`, `typescript.ignoreBuildErrors: true`, `reactStrictMode: false` in `next.config.ts`. Build copies `static` and `public` into `.next/standalone/` — don’t skip this custom step.
- **Prisma provider**: `prisma/schema.prisma` uses `postgresql` by default; `.env.example` shows SQLite path (`file:/home/z/my-project/db/custom.db`). Align provider with `DATABASE_URL` before `db:push/migrate`. Schema says “switch to Postgres” by changing provider.
- **Tests split**: Vitest excludes `tests/e2e/**` and `*.spec.ts` (Playwright specs). Coverage focuses on `src/lib/**`, `src/server/**`.
- **ESLint/TS lenient now**: `eslint.config.mjs` disables many strict rules; `tsconfig.json` has `strict: true` but `noImplicitAny: false`. Follow `PROJECT_RULES.md` regardless.
- **Security headers**: Applied globally in `next.config.ts` (HSTS, X-Frame-Options DENY, etc.). Server Actions have sandbox origin allowlist (includes `*.space-z.ai`, `localhost:3000`).
- **Auth model**: Database sessions (not pure JWT) per `PROJECT_RULES.md`. Google OAuth uses `AUTH_GOOGLE_*` (legacy `GOOGLE_*` still supported).
- **Validation**: Validate all inputs with Zod on the server even if client validates.
- **Demo login**: `demo@riskguard.app` / `riskguard1234` (after seeding).

## Structure (key)

- `src/app/` (App Router), `src/components/` (shadcn/ui in `components/ui`), `src/lib/` (pure utils/calc/format), `src/server/` (server-only actions/lib), `src/hooks/`, `src/types/`
- `prisma/` schema/migrations/seed. `tests/` unit/integration + `tests/e2e/`. `docs/` (ERD.md, FORMULAS.md). `PROJECT_RULES.md` is permanent.

## References

- `PROJECT_RULES.md` — permanent rules (money as Decimal, user scoping, phases, disclaimer)
- `README.md` — setup/deploy details (SQLite vs Postgres, Docker, Vercel)
- `PROGRESS.md` — phase tracker
- `TESTING.md`, `SECURITY.md`, `ARCHITECTURE.md`
