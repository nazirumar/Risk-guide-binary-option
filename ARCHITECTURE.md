# RiskGuard — Architecture

## Overview

RiskGuard is a Next.js 16 App Router application with a layered architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Client)                         │
│  React 19 + Tailwind + shadcn/ui + Recharts                 │
│  Client components: forms, charts, interactive UI           │
├─────────────────────────────────────────────────────────────┤
│                 Next.js Server (RSC + Actions)                │
│  Server Components → render HTML                            │
│  Server Actions → mutations (form submissions)             │
│  Route Handlers → API endpoints (auth, upload, export)     │
├─────────────────────────────────────────────────────────────┤
│                    Server Logic                              │
│  requireUser() → auth gate (session → userId)               │
│  evaluateRisk() → 8-rule risk engine                        │
│  recomputeAccountBalanceInTx() → atomic balance recompute   │
│  analytics.ts → aggregation + caching (React cache())       │
├─────────────────────────────────────────────────────────────┤
│                    Pure Library (/src/lib)                    │
│  calc/ → win rate, expectancy, equity curve, drawdown       │
│  staking/ → 8 plan implementations + Monte Carlo             │
│  timezone.ts → TZ-aware date computation                    │
│  format.ts → Intl currency/number/percent/date               │
│  db.ts → Prisma client singleton                            │
│  auth.ts → NextAuth config                                  │
│  email.ts → Resend abstraction                              │
│  storage.ts → file upload abstraction                       │
│  rate-limit.ts → rate limiting abstraction                  │
├─────────────────────────────────────────────────────────────┤
│                    Database (Prisma ORM)                     │
│  SQLite (dev) → PostgreSQL (prod)                           │
│  14 models, 22 indexes, 8 enums                             │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Principles

### 1. Money is Decimal, never Float (Rule #1)

All money fields use Prisma's `Decimal` type. The calc engine (`/src/lib/calc/`) uses `decimal.js` for all arithmetic. This prevents IEEE-754 floating-point errors (0.1 + 0.2 ≠ 0.3).

### 2. Every query is scoped by userId (Rule #3)

`requireUser()` returns the userId from the session. Every Prisma query includes `userId` in the `where` clause. Cross-user access is silently rejected (findFirst returns null, updateMany returns count:0).

### 3. Pure functions in /src/lib/calc (Rule #2)

All calculation functions (win rate, expectancy, profit factor, equity curve, drawdown, risk of ruin, staking plans, Monte Carlo) are pure — no DB, no side effects, fully unit-tested. The server layer calls them; the UI displays their results.

### 4. Atomic balance recompute

`recomputeAccountBalanceInTx()` runs inside `prisma.$transaction` on every trade/transaction mutation. It re-fetches ALL transactions + trades, recomputes the balance, and updates every trade's `balanceAfter` equity walk. Balance can never drift.

### 5. "use server" files export ONLY async functions

Next.js 16's Turbopack requires `"use server"` files to export only async functions. Types and constants live in separate non-"use server" files (e.g., `lockout-types.ts`, `notification-types.ts`).

## Phase Summary

| Phase | What was built                                 | Key files                                                          |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------ |
| 0     | Project foundation                             | package.json, tsconfig.json, PROJECT_RULES.md                      |
| 1     | Database schema (14 models, 22 indexes)        | prisma/schema.prisma, prisma/seed.ts, docs/ERD.md                  |
| 2     | Authentication (NextAuth + argon2 + Google)    | src/lib/auth.ts, src/lib/email.ts, src/lib/rate-limit.ts           |
| 3     | App shell (sidebar + bottom tab bar + top bar) | src/components/shell/_, src/components/trader/_                    |
| 4     | Accounts & cash flow (atomic balance)          | src/server/actions/accounts.ts, src/server/actions/transactions.ts |
| 5     | Trade journal (fast entry + quick-close)       | src/server/actions/trades.ts, src/components/trades/*              |
| 6     | Calculation engine (99.79% coverage)           | src/lib/calc/{types,normalize,rates,equity,risk,group-by}.ts       |
| 7     | Risk rules & lockouts (8-rule engine)          | src/server/lib/risk-check.ts, src/server/actions/lockout.ts        |
| 8     | Stake calculator (8 plans + Monte Carlo)       | src/lib/staking/_, src/components/staking/_                        |
| 9     | Analytics dashboard (charts + insights)        | src/server/lib/analytics.ts, src/components/analytics/*            |
| 10    | Goals & sessions (checklist + compounding)     | src/lib/calc/compounding.ts, src/components/goals/*                |
| 11    | Reports, import, export (CSV/XLSX/JSON)        | src/server/actions/{export,import,backup}.ts                       |
| 12    | Notifications & settings (PWA + prefs)         | src/server/actions/notifications.ts, public/manifest.json          |
| 13    | Hardening (security headers + CI + health)     | SECURITY.md, TESTING.md, .github/workflows/ci.yml                  |
| 14    | Deployment & docs                              | Dockerfile, docker-compose.yml, README.md, USER_GUIDE.md           |

## Server-Action Reference

| Action                          | File             | What it does                                     |
| ------------------------------- | ---------------- | ------------------------------------------------ |
| `registerAction`                | auth.ts          | Register + send verification email               |
| `verifyEmailAction`             | auth.ts          | Verify email token                               |
| `forgotPasswordAction`          | auth.ts          | Send password reset email                        |
| `resetPasswordAction`           | auth.ts          | Reset password with token                        |
| `completeOnboardingAction`      | onboarding.ts    | 3-step onboarding (locale + account + risk)      |
| `updateProfileAction`           | profile.ts       | Update name/timezone/currency                    |
| `changePasswordAction`          | profile.ts       | Change password (verifies current)               |
| `deleteAccountAction`           | profile.ts       | Delete account with cascade                      |
| `createTradingAccountAction`    | accounts.ts      | Create account (no auto-DEPOSIT)                 |
| `updateTradingAccountAction`    | accounts.ts      | Update account fields                            |
| `archiveTradingAccountAction`   | accounts.ts      | Archive (preserves history)                      |
| `restoreTradingAccountAction`   | accounts.ts      | Restore archived account                         |
| `createTransactionAction`       | transactions.ts  | Record deposit/withdrawal/bonus/adjustment       |
| `deleteTransactionAction`       | transactions.ts  | Delete transaction + recompute                   |
| `previewReconcileAction`        | transactions.ts  | Preview balance difference                       |
| `confirmReconcileAction`        | transactions.ts  | Create adjustment transaction                    |
| `createTradeAction`             | trades.ts        | Open a trade (runs evaluateRisk first)           |
| `closeTradeAction`              | trades.ts        | Quick-close WIN/LOSS/TIE + auto-lockout + alerts |
| `updateTradeAction`             | trades.ts        | Inline edit + recompute P/L                      |
| `deleteTradeAction`             | trades.ts        | Delete + recompute                               |
| `bulkDeleteTradesAction`        | trades.ts        | Bulk delete + per-account recompute              |
| `manualLockoutAction`           | lockout.ts       | "I need a break" self-imposed lockout            |
| `overrideLockoutAction`         | lockout.ts       | Override with phrase + reason + audit log        |
| `upsertRiskProfileAction`       | risk-rules.ts    | Edit risk limits                                 |
| `createStakingPlanAction`       | staking-plans.ts | Create saved plan                                |
| `setDefaultStakingPlanAction`   | staking-plans.ts | Set default plan                                 |
| `createGoalAction`              | goals.ts         | Create profit/balance target                     |
| `startSessionAction`            | sessions.ts      | Start trading session (checklist gate)           |
| `endSessionAction`              | sessions.ts      | End session + record end balance                 |
| `updateNotificationPrefsAction` | notifications.ts | Per-type in-app + email toggles                  |
| `updateTradingHoursAction`      | notifications.ts | Trading hours settings                           |
| `updateDailyJournalAction`      | goals.ts         | Daily reflection entry                           |
| `exportTradesCSV`               | export.ts        | Export trades as CSV                             |
| `exportTradesXLSX`              | export.ts        | Export trades as XLSX                            |
| `importTradesAction`            | import.ts        | CSV import with validation + dedup               |
| `exportBackupAction`            | backup.ts        | Full JSON backup                                 |
| `restoreBackupAction`           | backup.ts        | Restore from JSON                                |
