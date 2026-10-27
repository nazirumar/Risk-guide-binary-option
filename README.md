# RiskGuard

> Discipline-first money & risk management web app for binary options traders.
>
> ⚠️ **Risk Disclaimer**: Binary options are high-risk and most retail traders
> lose money. RiskGuard is a tracking and discipline tool — **not financial
> advice and not a broker**.

RiskGuard helps you size stakes, enforce daily loss limits, visualize equity &
drawdown, keep a tamper-proof trade journal, and stay honest about your real
edge. Built with Next.js 16 + TypeScript + Prisma + Tailwind + shadcn/ui.

## Features

| Module                    | Description                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Trade Journal**         | Fast mobile-first trade entry with searchable asset combobox, emotion tags, screenshot uploads, quick-close WIN/LOSS/TIE             |
| **Accounts & Cash Flow**  | Create DEMO/REAL accounts, record deposits/withdrawals/bonuses, reconcile against broker statements                                  |
| **Risk Rules & Lockouts** | Per-account limits (risk %, daily loss, consecutive losses, cooldowns), auto-lockout on breach, override with audit logging          |
| **Stake Calculator**      | Recommended stake, Kelly (full/half/quarter), 8 staking plans (incl. Martingale with red warning + hard cap), Monte Carlo simulation |
| **Analytics**             | Equity curve + drawdown chart, win rate by asset/hour/weekday/strategy/emotion, insights panel, period comparison                    |
| **Goals & Sessions**      | Daily/weekly/monthly profit targets, trading sessions with auto-linked trades, pre-trade checklist, compounding planner              |
| **Reports**               | Printable reports, CSV/XLSX export, CSV import wizard, full JSON backup/restore                                                      |

## Tech Stack

| Layer      | Choice                                       |
| ---------- | -------------------------------------------- |
| Framework  | Next.js 16 (App Router) + React 19           |
| Language   | TypeScript (strict mode)                     |
| ORM        | Prisma 6                                     |
| Database   | SQLite (dev) → PostgreSQL (prod)             |
| Auth       | NextAuth.js v4 (JWT + argon2 + Google OAuth) |
| Styling    | Tailwind CSS 4 + shadcn/ui (New York)        |
| Charts     | Recharts                                     |
| Money math | decimal.js (never floating point)            |
| Tests      | Vitest (371 tests) + Playwright (e2e)        |
| Deploy     | Docker / Vercel                              |

## Quick Start (Development)

### Prerequisites

- [Bun](https://bun.sh) (or Node 20+)
- (Optional) Docker Desktop, for local Postgres

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
# Generate a NextAuth secret:
openssl rand -base64 32
# Edit .env and set NEXTAUTH_SECRET to the value above.
```

### 3. Set up the database

Sandbox uses SQLite (zero config):

```bash
bun run db:push      # create/migrate schema
bun run db:seed      # seed demo data
```

Or switch to Postgres:

```bash
docker compose up -d postgres   # start Postgres
# In prisma/schema.prisma, change provider = "sqlite" to "postgresql"
# In .env, set DATABASE_URL="postgresql://riskguard:riskguard_dev_password@localhost:5432/riskguard"
bun run db:push
bun run db:seed
```

### 4. Run the dev server

```bash
bun run dev
```

Open the preview. Demo login: `demo@riskguard.app` / `riskguard1234`.

### 5. Quality gates

```bash
bun run lint         # ESLint
bun run typecheck    # tsc --noEmit
bun run test         # 371 unit/integration tests
bun run test:e2e     # Playwright e2e
```

## Deployment

### Option A: Docker Compose (Self-Hosting)

```bash
# 1. Copy and fill in environment
cp .env.example .env
# Set NEXTAUTH_SECRET, POSTGRES_PASSWORD, etc.

# 2. Build and run
docker compose up -d --build

# 3. Verify
curl http://localhost:3000/api/health
# → {"status":"ok","service":"riskguard"}
```

The app automatically runs `prisma migrate deploy` on startup.

### Option B: Vercel + Managed Postgres

1. **Create a managed Postgres database**:
   - [Neon](https://neon.tech) (recommended — serverless, free tier)
   - [Supabase](https://supabase.com)
   - [Railway](https://railway.app)

2. **Fork/push the repo to GitHub**.

3. **Import to Vercel**:
   - Go to [vercel.com/new](https://vercel.com/new)
   - Import the GitHub repo
   - Framework preset: Next.js
   - Build command: `bun run build` (or `npm run build`)

4. **Set environment variables** in Vercel:

   | Variable                   | Required | Example                                                             |
   | -------------------------- | -------- | ------------------------------------------------------------------- |
   | `DATABASE_URL`             | yes      | `postgresql://user:pass@ep.xxx.neon.tech/riskguard?sslmode=require` |
   | `NEXTAUTH_SECRET`          | yes      | (openssl rand -base64 32)                                           |
   | `NEXTAUTH_URL`             | yes      | `https://your-app.vercel.app`                                       |
   | `AUTH_GOOGLE_ID`           | no       | (for Google OAuth)                                                  |
   | `AUTH_GOOGLE_SECRET`       | no       | (for Google OAuth)                                                  |
   | `RESEND_API_KEY`           | no       | (for email)                                                         |
   | `EMAIL_FROM`               | no       | `RiskGuard <noreply@yourdomain.com>`                                |
   | `UPSTASH_REDIS_REST_URL`   | no       | (for rate limiting)                                                 |
   | `UPSTASH_REDIS_REST_TOKEN` | no       | (for rate limiting)                                                 |
   | `CRON_SECRET`              | no       | (for cron endpoint protection)                                      |

5. **Switch Prisma to Postgres**:
   - In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`
   - Push to GitHub — Vercel auto-deploys

6. **Run migrations** (first deploy only):
   - Add `npx prisma migrate deploy` to the Vercel build command, OR
   - Run locally with the production DATABASE_URL: `DATABASE_URL=xxx npx prisma migrate deploy`

7. **Set up Vercel Cron** (optional, for lockout cleanup):
   - Add to `vercel.json`:
     ```json
     { "crons": [{ "path": "/api/cron/expire-lockouts", "schedule": "0 * * * *" }] }
     ```
   - Set `CRON_SECRET` env var.

### Database Connection Pooling

| Approach                   | When to use                                                                      |
| -------------------------- | -------------------------------------------------------------------------------- |
| **PgBouncer**              | Self-hosted Postgres with many connections. Runs as a sidecar in docker-compose. |
| **Neon's built-in pooler** | Neon Postgres — add `?pgbouncer=true` to DATABASE_URL.                           |
| **Prisma Accelerate**      | Vercel/edge deployments with high cold-start rate. Adds a Prisma data proxy.     |

### Daily Postgres Backups

```bash
# Add to crontab on the Postgres host:
0 2 * * * pg_dump -U riskguard riskguard | gzip > /backups/riskguard-$(date +\%Y\%m\%d).sql.gz

# Retain 30 days:
0 3 * * * find /backups -name "riskguard-*.sql.gz" -mtime +30 -delete

# Restore:
gunzip -c /backups/riskguard-20261026.sql.gz | psql -U riskguard riskguard
```

### Domain, HTTPS, and Email Setup

- [ ] Point a DNS A record to your server IP (or Vercel domain).
- [ ] Configure HTTPS (Let's Encrypt via Caddy/Nginx, or Vercel's automatic SSL).
- [ ] Set `NEXTAUTH_URL` to the HTTPS domain.
- [ ] For email (Resend): verify your sending domain.
  - [ ] Add SPF record: `v=spf1 include:amazonses.com ~all`
  - [ ] Add DKIM record (from Resend dashboard).
  - [ ] Set `EMAIL_FROM` to `RiskGuard <noreply@yourdomain.com>`.

## Environment Variables

| Variable                   | Required | Description                                       |
| -------------------------- | -------- | ------------------------------------------------- |
| `DATABASE_URL`             | yes      | SQLite path or Postgres connection string         |
| `NEXTAUTH_URL`             | yes      | Public app URL                                    |
| `NEXTAUTH_SECRET`          | yes      | Random 32-byte secret (`openssl rand -base64 32`) |
| `AUTH_GOOGLE_ID`           | no       | Google OAuth client ID (Phase 25)                 |
| `AUTH_GOOGLE_SECRET`       | no       | Google OAuth client secret (Phase 25)             |
| `RESEND_API_KEY`           | no       | Resend API key for transactional email            |
| `EMAIL_FROM`               | no       | From-address for outgoing email                   |
| `UPSTASH_REDIS_REST_URL`   | no       | Upstash Redis URL for rate limiting               |
| `UPSTASH_REDIS_REST_TOKEN` | no       | Upstash Redis token                               |
| `CRON_SECRET`              | no       | Protects the `/api/cron/expire-lockouts` endpoint |
| `APP_NAME`                 | no       | App display name (default: `RiskGuard`)           |
| `APP_TIMEZONE`             | no       | Default timezone for new users (default: `UTC`)   |
| `DEFAULT_BASE_CURRENCY`    | no       | Default base currency (default: `USD`)            |

> **Google OAuth**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are still
> honored for backward compatibility, but new deployments should use
> `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. See "Google OAuth setup" below.

## Google OAuth setup

Phase 25 adds "Continue with Google" to the `/login` and `/register` pages.
The button only renders when `AUTH_GOOGLE_ID` (or the legacy
`GOOGLE_CLIENT_ID`) is set, so the sandbox stays clean.

### 1. Create Google OAuth credentials

1. Open the [Google Cloud Console → APIs & Services →
   Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Add **Authorized JavaScript origins**:
   - Local dev: `http://localhost:3000`
   - Production: `https://your-app.vercel.app` (or your custom domain)
5. Add **Authorized redirect URIs**:
   - Local dev: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://your-app.vercel.app/api/auth/callback/google`
6. Copy the **Client ID** and **Client Secret**.

### 2. Configure environment

```bash
# .env (or Vercel env vars)
AUTH_GOOGLE_ID="...client-id....apps.googleusercontent.com"
AUTH_GOOGLE_SECRET="...client-secret..."
NEXTAUTH_URL="https://your-app.vercel.app"   # must match Authorized redirect URI origin
```

### 3. Account-linking behavior

- **Brand-new Google user**: a `User` row is created with `emailVerified`
  set immediately and `passwordHash` left null. The user is sent through
  the onboarding wizard (locale, first trading account, risk profile).
- **Existing password user with the same verified email**: the Google
  account is linked to that user (no duplicate). If the password user's
  email wasn't verified yet, it's marked verified after the Google login.
- **Unverified Google email**: sign-in is aborted with
  `OAUTH_EMAIL_NOT_VERIFIED`. We never link accounts based on an
  unverified email.
- **Existing linked Google account**: normal sign-in. The `GOOGLE_SIGN_IN`
  audit log entry is written.

### 4. Security

- `allowDangerousEmailAccountLinking: false`. The `signIn` callback
  enforces `profile.email_verified` and pre-links existing email users
  manually so the Auth.js Prisma adapter doesn't trip on the email
  `@unique` constraint.
- OAuth state + PKCE protections are on by default in Auth.js v4 —
  don't disable them.
- Sign-in routes are rate-limited (10 attempts per 10 minutes per
  IP+email).
- All redirects are same-origin only (the `redirect` callback rejects
  any cross-origin `callbackUrl`).
- `GOOGLE_SIGN_IN`, `ACCOUNT_LINKED`, `ACCOUNT_UNLINKED`, and
  `SIGN_OUT_ALL_DEVICES` actions are written to the audit log.

### 5. Sign out of all devices

A `sessionVersion Int @default(0)` lives on `User`. The `jwt` callback
re-reads it periodically (≤60s) and strips the token if the DB value
differs. Bumping it via "Sign out of all devices" in Settings invalidates
every outstanding JWT on the next session access (proxy-level access is
lazy — the page will bounce on the next `requireUser()` call).

The Google session itself is NOT revoked (spec point 7: "Make sure sign
out does not revoke or log the user out of their Google account itself").

## Project Structure

```
/
├── prisma/                Prisma schema, migrations, seed
├── src/
│   ├── app/               Next.js App Router (pages, layouts, route handlers)
│   ├── components/        React components (shadcn/ui in components/ui)
│   ├── hooks/             Client-side hooks
│   ├── lib/               Pure utilities — calc/, format, db, email, storage, staking
│   ├── server/            Server-only: actions/, lib/ (requireUser, analytics, alerts, risk-check)
│   └── types/             Shared types
├── tests/                 Vitest unit/integration + Playwright e2e
├── docs/                  ERD.md, FORMULAS.md
├── Dockerfile             Multi-stage production build
├── docker-compose.yml     Self-hosting (Postgres + app)
├── PROJECT_RULES.md       Permanent rules — read first
├── PROGRESS.md            Phase tracker — 14 phases complete
├── SECURITY.md            Security model documentation
├── TESTING.md             Test strategy + coverage
└── README.md              ← this file
```

## Contributing

1. Pick the first unchecked phase in `PROGRESS.md` (all 14 are now complete).
2. Read `PROJECT_RULES.md` for permanent rules.
3. Implement; run all quality gates.
4. Update `PROGRESS.md` with the acceptance checklist results.
5. Commit: `git commit -m "phase X done"`.

## License

Proprietary — internal use only during development.
"# Risk-guide-binary-option" 
