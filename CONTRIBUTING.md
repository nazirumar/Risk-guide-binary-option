# Contributing to RiskGuard

## Development Setup

1. Clone the repo.
2. `bun install`
3. `cp .env.example .env` — fill in `NEXTAUTH_SECRET` (run `openssl rand -base64 32`).
4. `bun run db:push && bun run db:seed`
5. `bun run dev`
6. Open the preview. Login: `demo@riskguard.app` / `riskguard1234`.

## Permanent Rules

Read `PROJECT_RULES.md` before writing any code. Key rules:

1. Money is `Decimal` — never `Float`.
2. All calculations live in `/src/lib/calc` as pure, unit-tested functions.
3. Every database query is scoped by `userId`.
4. Validate all input with Zod on the server.
5. Mobile-first responsive UI, dark mode default, accessible.
6. `"use server"` files export ONLY async functions — types and constants go in separate files.
7. Never leave `TODO`s or mock data in finished features.
8. Audit-log every state-changing operation.

## Quality Gates

Before submitting a PR, ALL of these must pass:

```bash
bun run lint         # ESLint — 0 errors
bun run typecheck    # tsc --noEmit — clean
bun run test         # Vitest — 371+ tests pass
bun run test:e2e     # Playwright — e2e flows pass
```

## Commit Convention

```bash
git commit -m "phase X done"
```

## Adding a New Feature

1. **Pure logic first** — write the function in `/src/lib/calc/` with full unit tests.
2. **Server action** — write the server action in `/src/server/actions/` with Zod validation + userId scoping + audit logging.
3. **UI** — build the client component in `/src/components/`. Use shadcn/ui primitives. Mobile-first. Dark mode default.
4. **Wire it** — render the component from a server component page. Use `revalidatePath()` after mutations.
5. **Test** — unit test the pure logic. Integration-test the server action if it does DB mutations. E2E test the full flow.

## Test Conventions

- **Pure functions**: tested with plain JS objects, no DB. Edge cases: zero trades, all wins, all losses, payout 0, empty ranges, Decimal precision.
- **Integration tests**: use the real SQLite DB. `beforeEach` cleans all tables.
- **E2E tests**: use a fresh random email per run. Playwright auto-starts the dev server.
- **Timezone tests**: pass a fixed `now: Date` so the test is deterministic.

## Code Style

- TypeScript strict mode.
- `import type` for type-only imports.
- `Decimal` for all money fields.
- `decimal.js` for money math (never `number` or `float`).
- shadcn/ui components preferred over custom implementations.
- Lucide icons.
- Tailwind CSS classes — no indigo/blue colors.
- `"use client"` only when needed (state, effects, event handlers).
- `"use server"` files export ONLY `async function` declarations.
