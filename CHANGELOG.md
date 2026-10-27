# Changelog

All notable changes to RiskGuard are documented in this file.

## [0.1.0] — 2026-10-26

### Phase 0: Project Rules and Foundation

- Next.js 16 App Router + TypeScript strict mode + path alias `@/`
- Prisma ORM + SQLite (dev) / PostgreSQL (prod)
- Auth.js (NextAuth v4) with email/password + Google OAuth
- Tailwind CSS 4 + shadcn/ui (New York) + lucide-react icons
- Zod validation, React Hook Form, TanStack Query
- Recharts for charts, decimal.js for money math
- Vitest (unit tests) + Playwright (e2e)
- ESLint + Prettier + Husky + lint-staged
- Docker Compose for local Postgres reference
- PROJECT_RULES.md + PROGRESS.md + README.md

### Phase 1: Database Schema

- 14 Prisma models (User, Account, Authenticator, AuthSession, VerificationToken, PasswordReset, TradingAccount, Transaction, Strategy, Trade, RiskProfile, StakingPlan, TradingSession, Goal, Lockout, Notification, AuditLog)
- 8 enums (AccountType, TransactionType, TradeDirection, TradeResult, TradeEmotion, StakingMethod, GoalType, GoalStatus, LockoutReason, TradingSessionMood)
- 22 indexes covering all hot query paths
- Deterministic seed script (1 demo user, 2 accounts, 3 strategies, 150 trades, transactions, risk profile)
- ERD in docs/ERD.md (Mermaid)

### Phase 2: Authentication

- Auth.js v4 with Prisma adapter, JWT session strategy
- Credentials provider (argon2 password hashing, timing-safe verification)
- Google OAuth (env-gated)
- 5 auth pages (/login, /register, /forgot-password, /reset-password, /verify-email)
- Email via Resend (abstracted behind /src/lib/email.ts, dev console fallback)
- Zod password rules (min 8, upper+lower+digit+special)
- Rate limiting on all auth endpoints (Upstash + in-memory fallback)
- Generic error messages (no account enumeration)
- 3-step onboarding wizard (locale + first account + risk profile)
- requireUser() server helper

### Phase 3: App Shell and UI System

- Collapsible sidebar (desktop) + bottom tab bar (mobile)
- Top bar with account switcher, theme toggle, notifications bell, user menu
- 9 nav routes (Dashboard, Trades, Accounts, Risk Rules, Stake Calculator, Analytics, Goals, Reports, Settings)
- Trader palette: emerald profit, red loss, amber warning, slate neutral
- Dark mode default (next-themes)
- Reusable components: StatCard, MoneyText, PercentBadge, EmptyState, DataTable, ConfirmDialog, FormField, DateRangePicker, RiskDisclaimer
- Error boundary pages (error.tsx, not-found.tsx, loading.tsx)
- Active-account context (cookie-persisted)
- Lighthouse accessibility = 100/100

### Phase 4: Accounts and Cash Flow

- Accounts page with card grid (name, broker, DEMO/REAL badge, balance, today P/L)
- Create/edit/archive/restore trading accounts
- Deposits/withdrawals/bonuses/adjustments with date + note
- Atomic balance recompute (prisma.$transaction + recomputeAccountBalanceInTx)
- Transaction history with CSV export
- Reconcile balance action (enter broker balance → preview diff → create ADJUSTMENT)
- 17 integration tests (atomic balance + cross-user isolation)

### Phase 5: Trade Journal

- Fast mobile-first trade entry form (auto-focused stake, expiry presets)
- Searchable asset combobox (39 common assets + OTC pairs, free text allowed)
- Live preview (potential profit/loss/risk%/break-even)
- Quick-close WIN/LOSS/TIE buttons on OPEN trades
- Trades table with filters (date/asset/result/strategy/emotion/plan/tags)
- Sorting, pagination, bulk delete, inline edit, trade detail drawer
- Screenshot upload (local file storage, pluggable for S3/Uploadthing)
- Risk-check hook point (stub → Phase 7 fills in)
- 8 integration tests (trade P/L + balanceAfter equity walk)

### Phase 6: Calculation Engine

- Pure TypeScript functions using decimal.js, 99.79% coverage
- winRate, lossRate, tieRate, breakEvenWinRate
- expectancyPerTrade, expectancyInR, profitFactor, averageWin/Loss, payoffRatio
- netProfit, grossProfit, grossLoss, ROI
- equityCurve, maxDrawdown (amount + %), currentDrawdown, recoveryFactor
- longestWinStreak, longestLossStreak, currentStreak
- riskOfRuin (gambler's-ruin approximation)
- consistencyScore (Sharpe-like mean/stdDev)
- groupBy helpers (asset/hour/weekday/strategy/emotion/direction)
- lossesToRuin calculator
- docs/FORMULAS.md (plain-language formula reference)

### Phase 7: Risk Rules and Lockouts

- Real evaluateRisk() implementation (8 rules: stake>limit, daily loss, weekly loss, daily target, consec losses, max trades/day, max open trades, active lockout)
- TZ-aware "today" and "this week" (startOfTodayUtc, startOfWeekUtc)
- Auto-create lockout after breach (DAILY_LOSS → next midnight, WEEKLY_LOSS → next Sunday, CONSEC_LOSSES → cooldownMinutes)
- LockoutBanner with live countdown (useSyncExternalStore for hydration-safe clock)
- Manual lockout button ("I need a break")
- Override flow (confirmation phrase + reason + audit log)
- Risk Meter widget (progress bars amber/red)
- Cron endpoint (/api/cron/expire-lockouts, token-protected)
- 23 integration tests (all 8 rules + 6 TZ edge cases)

### Phase 8: Stake Calculator and Plans

- 8 staking plans (FIXED_AMOUNT, FIXED_PERCENT, COMPOUNDING, ANTI_MARTINGALE, FIBONACCI, MARTINGALE-off-by-default, KELLY_FRACTION, CUSTOM)
- Kelly variants (full/half/quarter with aggressive warning)
- Monte Carlo simulation (1,000 × 100 trades, seeded PRNG)
- Next-stake suggestion in Add Trade form (clamped to Risk Rules limit)
- CRUD for saved staking plans with default plan
- 51 unit tests (40 plans + 11 Monte Carlo)

### Phase 9: Analytics Dashboard

- Dashboard: 8 stat cards (balance/today-week-month P/L/win rate/PF/streak/trades)
- Equity curve mini-chart
- Analytics page with date range + account/strategy filters
- Equity curve + drawdown chart, win rate by 6 dimensions
- Followed-plan vs broke-plan comparison
- Stake-size distribution histogram
- Insights panel (rule-based plain-language findings)
- Period comparison (current vs previous)
- Server-side aggregation with React cache()

### Phase 10: Goals and Trading Sessions

- Daily/weekly/monthly profit targets with progress bars
- Realistic-check warning (>10% daily = unsustainable)
- Trading sessions (start/end with auto-linked trades + summary cards)
- Pre-trade checklist (user-configurable, must be ticked)
- Daily journal entry
- Compounding planner (table projecting balance growth)
- 10 unit tests (compoundingPlan + checkRealisticGoal)

### Phase 11: Reports, Import, Export

- Reports page (daily/weekly/monthly presets, printable layout)
- CSV + XLSX export for trades and transactions
- CSV import wizard (paste → parse → map → preview → validate → import in transaction)
- Full JSON backup export + restore
- Report content: summary stats, equity curve, rule breaches, overrides, best/worst trades, notes

### Phase 12: Notifications and Settings

- In-app notification center with mark-all-read
- Alert generation (risk 80%/100%, lockout started, goal achieved)
- Per-type notification preferences (7 types × in-app + email)
- PWA (manifest.json, offline fallback page)
- Enhanced settings (profile + notification prefs + trading hours + default staking plan + theme + password + delete account)

### Phase 13: Hardening

- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Health endpoint (/api/health)
- GitHub Actions CI workflow
- Dependency audit (123 vulnerabilities — all in dev dependencies)
- Fixed "use server" export errors (types/constants moved to separate files)
- Fixed LockoutBanner hydration mismatch (useSyncExternalStore)
- SECURITY.md + TESTING.md

### Phase 14: Deployment and Docs

- Multi-stage Dockerfile (deps → build → runtime)
- docker-compose.yml for self-hosting (Postgres + app)
- Vercel deployment instructions with managed Postgres
- Prisma migration deploy step (runs on container startup)
- Daily Postgres backup guidance + restore guide
- Connection pooling notes (PgBouncer / Neon pooler / Prisma Accelerate)
- Domain/HTTPS/SPF/DKIM setup checklist
- Updated README (overview, screenshots, features, deployment, env vars)
- USER_GUIDE.md (how a trader uses each module)
- ARCHITECTURE.md (layered architecture + server-action reference)
- CONTRIBUTING.md (development setup + rules + conventions)
- CHANGELOG.md (this file)
- Final audit: all 14 phases verified
