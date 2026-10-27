# RiskGuard — Testing

> Phase 13 deliverable. Documents the test strategy, coverage, and how to run tests.

## Test Stack

| Layer       | Tool                   | What it covers                                                                                              |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unit        | Vitest 3               | Pure calc functions (`/src/lib/calc/*`), staking plans, risk-of-ruin, timezone helpers, formatting          |
| Integration | Vitest 3 (real SQLite) | Server-action-level tests: balance recompute, cross-user isolation, trade P/L, risk-check rules             |
| E2E         | Playwright             | Full browser flows: register → verify-email → login → onboarding → add trade → close trade → view analytics |
| Lint        | ESLint 9               | Code quality + Next.js rules                                                                                |
| Type        | TypeScript 5 (strict)  | Type safety across the entire codebase                                                                      |

## Test Files

```
tests/
├── e2e/
│   └── auth-flow.spec.ts          # Phase 2: register → verify → login → onboarding
├── calc/
│   ├── rates.test.ts              # Phase 6: 57 tests — win/loss/tie rates, expectancy, profit factor, ROI
│   ├── equity.test.ts             # Phase 6: 27 tests — equity curve, drawdowns, recovery, streaks
│   ├── risk.test.ts               # Phase 6: 29 tests — risk of ruin, losses to ruin, consistency score
│   └── group-by.test.ts           # Phase 6: 12 tests — groupBy helpers
├── staking/
│   ├── plans.test.ts              # Phase 8: 40 tests — all 8 staking plans + Martingale helpers
│   └── monte-carlo.test.ts        # Phase 8: 11 tests — simulation determinism + aggregation
├── account-balance.test.ts        # Phase 4: 34 tests — signedTransactionAmount, recomputeAccountBalance
├── accounts-integration.test.ts   # Phase 4: 17 tests — atomic balance recompute + cross-user isolation
├── risk-check.test.ts             # Phase 7: 23 tests — all 8 evaluateRisk rules + TZ edge cases
├── timezone.test.ts               # Phase 7: 22 tests — startOfToday/Week in UTC/Lagos/NY/Honolulu/Kiritimati/Auckland DST
├── trades-integration.test.ts     # Phase 5: 8 tests — trade open/close/edit/delete + balanceAfter equity walk
├── trade-calc.test.ts             # Phase 5: 19 tests — computeTradeProfitLoss, potentialProfit/Loss, risk%
├── format.test.ts                 # Phase 3: 26 tests — Intl currency/number/percent/date formatting
├── validation.test.ts             # Phase 2: 34 tests — Zod schemas (password rules, trade/trx/goal validation)
├── compounding.test.ts            # Phase 10: 10 tests — compoundingPlan + checkRealisticGoal
└── sanity.test.ts                 # Phase 0: 2 tests — Vitest runner + decimal.js precision
```

**Total: 371 tests across 16 files.**

## Coverage

Run `bun run test:coverage` to generate a coverage report.

Current coverage on `/src/lib` and `/src/server`:

| Module                  | Statement Coverage | Notes                                                                           |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `/src/lib/calc/*`       | ~99%               | All pure math functions fully covered                                           |
| `/src/lib/format.ts`    | ~82%               | Intl formatting covered, some edge cases                                        |
| `/src/lib/timezone.ts`  | ~100%              | All TZ helpers covered with edge cases                                          |
| `/src/lib/staking/*`    | ~100%              | All 8 plans + Monte Carlo covered                                               |
| `/src/server/actions/*` | ~30%               | Server actions need integration DB — Phase 4/5/7 tests cover the critical paths |
| `/src/server/lib/*`     | ~40%               | Risk-check + analytics + alerts covered via integration tests                   |

Target: ≥80% on `/src/lib` (achieved). `/src/server` at ~40% — the critical paths (balance recompute, cross-user isolation, risk-check rules) are covered; the CRUD actions are thin wrappers around Prisma queries that are tested via the integration tests.

## How to Run

```bash
# Unit + integration tests
bun run test

# Watch mode
bun run test:watch

# With coverage
bun run test:coverage

# E2E (starts dev server automatically)
bun run test:e2e

# Lint
bun run lint

# Type check
bun run typecheck

# All in one
bun run lint && bun run typecheck && bun run test && bun run test:e2e
```

## CI/CD

GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push + PR:

1. `bun install`
2. `bun run lint`
3. `bun run typecheck`
4. `bun run test`
5. `bun run build` (production build check)

E2E tests run separately (they need a running dev server).

## Test Conventions

- **Pure functions**: tested with plain JS objects, no DB, no mocks. Fast (<10ms per file).
- **Integration tests**: use the real SQLite database (same as the dev one). `beforeEach` cleans all tables + seeds fresh data. Slow (~2-3s per file) but tests the real Prisma queries.
- **E2E tests**: use a fresh random email per run for idempotency. Playwright auto-starts the dev server.
- **Edge cases**: every function is tested against zero trades, all wins, all losses, payout 0, empty ranges, and Decimal precision (0.1 + 0.2 = 0.3, not 0.30000000000000004).
- **Timezone**: `evaluateRisk` accepts an optional `now: Date` parameter so TZ tests are deterministic (don't depend on the test runner's clock).

## Adding New Tests

1. **Pure calc function**: add to `tests/calc/<module>.test.ts`. Use `Decimal` for all money values.
2. **Server action**: add to `tests/<feature>-integration.test.ts`. Use the real DB with `beforeEach` cleanup.
3. **E2E flow**: add to `tests/e2e/<flow>.spec.ts`. Use a fresh email per run.
4. **Always test edge cases**: zero/empty/all-wins/all-losses/payout-0/Decimal-precision.
