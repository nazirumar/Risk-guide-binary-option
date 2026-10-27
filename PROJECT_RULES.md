# RiskGuard — Project Rules (Permanent)

> These rules apply to **every** phase of the RiskGuard project. They are copied
> from Phase 0 and must not be silently overridden. If a phase requires a
> deviation, raise it explicitly and update this file.

## Mission

RiskGuard is a **professional money-management and risk-management web app for
binary options traders**. It exists to enforce discipline, track money with
mathematical precision, and surface the analytics that actually move a trader's
long-term edge — win rate, expectancy, drawdown, break-even, and lockouts.

## Tech Stack

- **Next.js 16 (App Router) + TypeScript (strict mode)**
- **Prisma ORM + PostgreSQL** (production) — local sandbox uses SQLite via
  `prisma/schema.prisma`; see `docker-compose.yml` to spin up Postgres.
- **Auth.js (NextAuth v5/v4)** with email/password + Google OAuth
- **Tailwind CSS + shadcn/ui + lucide-react** icons
- **Zod** for validation, **React Hook Form** for forms
- **TanStack Query** for client data fetching, **Server Actions / Route Handlers** for the API
- **Recharts** for charts
- **decimal.js** for ALL money math (never use floating point for money)
- **Vitest** (unit tests) + **Playwright** (e2e)
- **ESLint + Prettier + Husky + lint-staged**
- **Docker Compose** for local Postgres reference

## Permanent Rules

1. **Money is stored in Prisma as `Decimal`** (or integer minor units). Never `Float`.
2. All calculations (stake sizing, drawdown, expectancy, win rate, break-even
   win rate) live in `/src/lib/calc` as pure, unit-tested functions.
3. **Every database query is scoped by `userId`.** A user must never see another
   user's data.
4. **Validate all input with Zod on the server**, even if the client validates too.
5. **Mobile-first responsive UI**, dark and light mode, accessible
   (labels, focus, contrast).
6. Folder structure: `/src/app`, `/src/components`, `/src/lib`, `/src/server`,
   `/src/hooks`, `/src/types`, `/prisma`, `/tests`.
7. Never leave `TODO`s or mock data in finished features. Seed script is OK for dev.
8. Write clear commit-ready code with comments only where logic is non-obvious.
9. At the end of each phase: **run lint, typecheck, tests and build, fix errors**,
   then update `PROGRESS.md` and print the acceptance checklist with PASS/FAIL.
10. **Do NOT start the next phase until I say so.** Do not skip or merge phases.
11. The app must include a **visible risk disclaimer**: binary options are high
    risk and most traders lose money; this tool is for discipline and tracking,
    not financial advice.
12. **Martingale-style staking may exist as an option but must always show a red
    warning and be OFF by default.**

## Folder Layout (target — Phase 0 establishes the skeleton)

```
/
├── prisma/                 Prisma schema, migrations, seed script
├── src/
│   ├── app/                Next.js App Router pages, layouts, route handlers
│   ├── components/         React components (shadcn/ui lives in components/ui)
│   ├── hooks/              Client-side hooks
│   ├── lib/                Pure utilities — calc/, format.ts, db.ts, email.ts
│   ├── server/             Server-only code: actions, services, auth
│   └── types/              Shared TypeScript types
├── tests/
│   ├── e2e/                Playwright specs
│   ├── setup.ts            Vitest setup
│   └── *.test.ts           Unit + integration tests
├── docs/                   ERD, FORMULAS, architecture docs (Phase 1+)
├── scripts/                Generation scripts (must live under /home/z/my-project)
├── docker-compose.yml      Local Postgres reference
└── PROJECT_RULES.md        ← this file
```

## Where Files Live

- **Final user-facing deliverables** (documents, charts, datasets): `/home/z/my-project/download/`
- **Generation scripts** (Python/Node/Shell longer than ~10 lines): `/home/z/my-project/scripts/`
- **Worklog** (single shared multi-agent log): `/home/z/my-project/worklog.md`

## Phase Order

| #   | Phase                        |
| --- | ---------------------------- |
| 0   | Project rules and foundation |
| 1   | Database schema              |
| 2   | Authentication               |
| 3   | App shell and UI system      |
| 4   | Accounts and cash flow       |
| 5   | Trade journal                |
| 6   | Calculation engine           |
| 7   | Risk rules and lockouts      |
| 8   | Stake calculator and plans   |
| 9   | Analytics dashboard          |
| 10  | Goals and trading sessions   |
| 11  | Reports, import, export      |
| 12  | Notifications and settings   |
| 13  | Security, performance, tests |
| 14  | Deployment and docs          |

See `PROGRESS.md` for live status of each phase.
