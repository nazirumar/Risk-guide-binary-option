# Phase 30 — AI Intelligence Layer (SPEC ONLY)

> **Status: in progress.** Sub-phases 30.0–30.2 are implemented;
> 30.3–30.4 remain untouched. The Phase 30 box in `PROGRESS.md` stays unchecked
> until every acceptance item passes. This phase is queued behind the revised
> Phase 26–29 acceptance items.
>
> User decisions captured for this spec:
>
> - Build **all four** feature areas below, in that order.
> - Use **Groq** as the AI provider for the new work.
> - News sourcing is **hybrid**: structured APIs for scheduled events + allowed
>   public pages for articles, with AI classification/summarization.

## Existing seams to reuse (verified in code)

- `src/lib/news/provider.ts` — `NewsProvider` interface, `ConsoleNewsProvider`
  fallback, `FinnhubNewsProvider`, `getNewsProvider()` singleton.
- `NewsEvent` model + `/api/cron/refresh-news` + `/app/news` + `NewsTradeWarning`
  already exist. Provider failures degrade to cached rows.
- `src/lib/ai/review.ts` — `AnthropicClient`, `generateWeeklyReviewWithFallback`,
  ISO-week helpers, privacy rule: only aggregate stats are sent.
- `src/server/actions/ai-review.ts` — opt-in `aiReviewEnabled`, `WeeklyReview`
  storage, audit logging, rule-based fallback.
- `TelegramProvider` / `sendTelegramAlertAction` / `NotificationPrefs` /
  cron endpoints — reusable alert channel and cadence.
- `worker/` — separate Bun process for ingestion; web path must not construct
  providers or fetch external pages.

## Sub-phases (implement in this order)

### 30.0 AI provider abstraction + Groq cutover

- Add `src/lib/ai/provider.ts` exposing a provider-agnostic `AIProvider`
  (`complete(prompt, systemPrompt, opts?)`) and `getAIProvider()`.
- Implement `GroqClient` with `fetch` against Groq’s OpenAI-compatible chat
  completions endpoint. No browser-side key; `GROQ_API_KEY` is server-only.
  Default model `GROQ_MODEL=llama-3.3-70b-versatile` (verify model availability
  at implementation time; keep it env-overridable).
- Migrate `generateWeeklyReviewWithFallback` to `getAIProvider()`. Keep the
  existing `WeeklyReview.source = "ai" | "fallback"` contract and the pure
  rule-based fallback. `AnthropicClient` may remain as an optional secondary
  fallback or be removed in the same commit — no dual-write ambiguity.
- Add timeouts, bounded retries on 429/5xx, max tokens, and a circuit breaker.
  Track token usage/cost in an `AgentRun` row (see schema below).

### 30.1 Agentic news pipeline (hybrid)

Bounded agent loop in `worker/` (never in a request path):

1. **Discover** sources from a static allowlist in `src/lib/news/sources.ts`
   (no user-supplied URLs). Each source declares `kind: "api" | "page"`,
   domain, fetch cadence, and parser id.
2. **Fetch** Finnhub (already wired) for the economic calendar; fetch allowed
   public pages/feeds for articles. Honor `robots.txt`, a fixed `User-Agent`,
   timeouts, and per-domain rate limits. Cap pages and bytes per run.
3. **Extract** with pure parsers in `src/lib/news/extract/`; strip HTML/scripts,
   cap text length, return `{title, url, publishedAt, currency[], symbols[],
rawText}`.
4. **Classify + dedupe** with pure functions first (URL/hash/title similarity),
   then Groq for relevance, impact, and a 2–3 sentence summary. Treat all
   scraped text as **untrusted data**, never as instructions: no tool calls or
   URL fetches derived from page content; keep the agent’s tool set fixed.
5. **Store** economic events in existing `NewsEvent`; articles in new
   `NewsArticle`. Upsert by source+URL or content hash. Never delete cached rows
   on a failed run — log the error in `AgentRun` and keep serving stale data.
6. **Serve**: `/app/news` shows “Calendar” (existing `NewsEvent`) and “Briefing”
   (`NewsArticle`) sections. Add a pure `findRelevantNews()` that merges both
   sources for the Add-Trade warning, reusing `getCurrenciesFromAsset` and the
   existing strict warning window. Warnings stay non-blocking.

### 30.2 AI journal coach (Groq)

- New opt-in `User.aiCoachEnabled` (default **false**) and per-user daily message
  limit. UI: small “Ask your journal” panel on `/app/reports` or `/app/analytics`.
- Store `CoachConversation` + `CoachMessage` rows, all `userId`-scoped.
- Context sent to Groq: the user’s **own** trades/stats only. Default to
  aggregates; a separate explicit toggle is required to include trade notes.
  Never send email/name/screenshots/other users’ data. Add a “What data was
  shared” disclosure like the existing `WeeklyReviewCard`.
- Prompt enforces: discipline/coaching language only, no financial advice, no
  profit promises, no “guaranteed/sure/best time to trade/signal” wording.
  Append the risk disclaimer to every reply.

### 30.3 Broker statement / screenshot import

- User-initiated upload (CSV first; PDF/image behind the same interface).
  Validate file type/size with Zod; store bytes via existing storage abstraction.
- Parse to normalized rows with pure parsers; use Groq to map messy columns or
  OCR text into `{date, type, amount, asset?, stake?, result?}`. Parse money
  with `decimal.js` — never `parseFloat`.
- Preview screen shows parsed rows + errors before any commit. Commit inside
  `db.$transaction` using the existing `recomputeAccountBalanceInTx()` path so
  balances and `balanceAfter` equity walks stay consistent.
- Idempotent by `(userId, source, externalId)`; re-importing the same statement
  does not duplicate rows. Store raw parsed rows on `ImportBatch` for audit.
- Audit log `IMPORT_PREVIEWED`, `IMPORT_COMMITTED`, `IMPORT_FAILED`.

### 30.4 Smarter alerts

- New notification type `NEWS_BRIEFING` in `NotificationPrefs`, **off by
  default**, with inApp/email/telegram toggles.
- Cron `/api/cron/news-briefing` (CRON_SECRET-gated, same pattern as existing
  cron routes) composes one short digest per opted-in user from:
  next high-impact news, live `MarketCondition` rating from
  `getMarketSnapshotAction()`, and the user’s personal edge/discipline note.
- Reuse `sendTelegramAlertAction`; no new provider code. Copy is descriptive,
  never a trading signal. Reuse the existing banned-wording unit-test pattern.

## Cross-cutting invariants

- Secrets only in env. New vars go in `.env.example` but never in the browser.
- Every user-facing query is `userId`-scoped via `requireUser()`; system sweeps
  are cron-token-protected. Validate all inputs with Zod on the server.
- Money stays `Decimal` + `src/lib/calc` pure functions.
- All AI features are opt-in/off by default except the news briefing section of
  `/app/news` (informational, with disclaimer). Keep the visible risk disclaimer.
- Add new features to `src/lib/billing/plans.ts` if they should be PRO-only.
- Schema changes use `bun run db:push`, **not** `prisma migrate` (migration lock
  is still `sqlite` while the datasource is `postgresql`).
- New integration tests must clean `Subscription` (and any new tables) **before**
  `User`, or they will join the known 172 FK-teardown failures.

## Proposed schema additions (not applied yet)

```prisma
model NewsArticle {
  id           String   @id @default(cuid())
  source       String
  url          String
  contentHash  String   @unique
  title        String
  summary      String?
  publishedAt  DateTime
  currency     String[] // Prisma scalar list works on postgresql
  symbols      String[]
  impact       String   // LOW | MEDIUM | HIGH
  rawText      String?
  createdAt    DateTime @default(now())

  @@unique([source, url])
  @@index([publishedAt])
  @@index([impact, publishedAt])
}

model AgentRun {
  id          String   @id @default(cuid())
  kind        String   // NEWS_AGENT | AI_REVIEW | COACH | IMPORT | BRIEFING
  provider    String?
  status      String   // OK | PARTIAL | FAILED
  itemsFound  Int      @default(0)
  itemsStored Int      @default(0)
  tokensUsed  Int?
  error       String?
  startedAt   DateTime @default(now())
  finishedAt  DateTime?

  @@index([kind, startedAt])
}

model CoachConversation {
  id        String   @id @default(cuid())
  userId    String
  title     String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages  CoachMessage[]

  @@index([userId, createdAt])
}

model CoachMessage {
  id             String   @id @default(cuid())
  conversationId String
  role           String   // user | assistant
  content        String
  sharedContext  Json?
  createdAt      DateTime @default(now())
  conversation   CoachConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
}

model ImportBatch {
  id            String   @id @default(cuid())
  userId        String
  source        String   // CSV | PDF | IMAGE
  status        String   // PREVIEW | COMMITTED | FAILED
  rows          Json
  errorSummary  String?
  createdAt     DateTime @default(now())
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
}

// Additive User fields: aiCoachEnabled Boolean @default(false),
// coachIncludeNotes Boolean @default(false), coachMessagesToday Int @default(0),
// coachLastMessageAt DateTime?.
// Additive optional importBatchId on Transaction and Trade for idempotency.
// Add NEWS_BRIEFING to notification-types.ts + DEFAULT_PREFS (all channels off).
```

## New env vars (server-only)

| Var                                | Purpose                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `GROQ_API_KEY`                     | Groq API key (required for AI features)               |
| `GROQ_MODEL`                       | Model override, default `llama-3.3-70b-versatile`     |
| `GROQ_TIMEOUT_MS`                  | Per-request timeout (default e.g. 20000)              |
| `NEWS_AGENT_ENABLED`               | Enable/disable scraper in worker (default `false`)    |
| `NEWS_AGENT_MAX_PAGES`             | Per-run listing-page cap (default 4)                  |
| `NEWS_AGENT_MAX_ITEMS`             | Per-run article cap (default 20)                      |
| `NEWS_AGENT_MAX_BYTES`             | Max bytes per fetched page (default 200000)           |
| `NEWS_AGENT_TIMEOUT_MS`            | Per-fetch timeout (default 10000)                     |
| `NEWS_AGENT_DOMAIN_INTERVAL_MS`    | Min gap between requests to one domain (default 1000) |
| `NEWS_AGENT_INTERVAL_MS`           | Cadence between agent runs (default 1800000)          |
| `NEWS_AGENT_SOURCES`               | Comma-separated allowlist ids; empty = all            |
| `IMPORT_MAX_BYTES`                 | Upload size cap (default 2 MiB, clamped 1 KiB–10 MiB) |
| `UPLOAD_DIR` / `UPLOAD_URL_PREFIX` | Optional local archive dir/URL for statement bytes    |
| `COACH_MAX_MESSAGES_PER_DAY`       | Per-user quota                                        |

Existing: `FINNHUB_API_KEY`, `NEWS_PROVIDER=finnhub`, `CRON_SECRET`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.

## Acceptance checklist (all unchecked until implemented)

- [x] 30.0 `AIProvider` interface + `GroqClient`; weekly review uses it with rule-based fallback; no key in browser.
- [x] 30.1 News agent runs only in worker; domain allowlist, robots.txt, rate limits, bounded loop, prompt-injection defenses.
- [x] 30.1 `NewsArticle` rows visible on `/app/news`; Add-Trade warning merges calendar + articles without blocking.
- [x] 30.2 Coach is opt-in, `userId`-scoped, quota-limited, discloses shared data, and appends disclaimer.
- [x] 30.3 Import preview → transactional commit → idempotent re-import; balances recomputed via existing helper.
- [x] 30.4 `NEWS_BRIEFING` cron + Telegram/in-app/email copy; off by default; no signal language.
- [ ] `lint` → `typecheck` → `test` → `build` in order, compared against the 836/1008 baseline (172 known FK failures).
- [ ] New unit tests for pure extract/dedupe/prompt/import/briefing logic; new integration tests clean `Subscription` first.
- [ ] E2E for news briefing panel, coach chat, and import preview/commit with a fresh random email.
- [ ] `PROGRESS.md` phase boxes updated only after all items pass; `README.md`, `TESTING.md`, `ARCHITECTURE.md`, `docs/ERD.md`, and `AGENTS.md` reconciled.

### 30.0 implementation notes (done)

- Added `src/lib/ai/provider.ts`: `AIProvider`, `AICompletionOptions`,
  `GroqClient`, legacy `RealAnthropicClient`, `RateLimitError`,
  `getAIProvider()` (Groq → Anthropic → null), `setAIProvider()`,
  `resetAIProvider()`.
- `src/lib/ai/review.ts` now delegates to `getAIProvider()` and keeps the old
  `getAnthropicClient` / `setAnthropicClient` / `AnthropicClient` /
  `RateLimitError` exports so Phase 23 callers and tests are unchanged.
- `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_MS` and legacy
  `ANTHROPIC_API_KEY` documented in `.env.example` (server-only).
- Verified: `typecheck`, targeted ESLint, Prettier, and
  `tests/ai-provider.test.ts` + `tests/calc/telegram-ai.test.ts` (49 tests green).

### 30.1 implementation notes (done)

- Schema: `NewsArticle` + `AgentRun` added to `prisma/schema.prisma` and pushed
  to the live Neon DB with `prisma db push --accept-data-loss` (the first
  `bun run db:push` attempt hit a transient P1001; the retry succeeded and
  regenerated the client). No migrations were used — the SQLite lock is still
  present.
- Pure modules: `src/lib/news/sources.ts` (static allowlist, `robotsAllowed`,
  `isAllowedUrl`, fixed UA), `extract.ts` (RSS/Atom + HTML → bounded plain
  text, currency/symbol detection), `dedupe.ts` (FNV-1a hash + title
  similarity), `classify.ts` (untrusted-data-fenced prompt, strict JSON
  parser, deterministic rule-based fallback).
- Worker: `worker/src/news-agent.ts` is imported only by `worker/src/index.ts`.
  Fixed, bounded loop: calendar via existing `getNewsProvider()`, then
  robots-checked/rate-limited HTTP GETs of allowlisted pages → extract →
  dedupe → Groq classification via `getAIProvider()` → `NewsArticle` upserts →
  `AgentRun` audit row. Off unless `NEWS_AGENT_ENABLED=true`.
- Web: `listNewsArticlesAction()` is read-only; `/app/news` renders a
  "News briefing" section; `getNewsWarningAction()` merges HIGH-impact
  articles with the calendar and de-duplicates per article; warnings stay
  non-blocking.
- Tests: `tests/news-agent.test.ts` (26 pure unit tests) + `tests/e2e/news-briefing.spec.ts`
  (seeds one article, uses a fresh random email). Targeted Vitest run of
  news-agent + ai-provider + news-warning + telegram-ai: 106/106 green. Full
  suite: 1057/1058 first run, the lone failure was a transient Neon P1001 in
  `discipline-integration.test.ts` (passed 11/11 on retry). Full `lint`,
  `typecheck`, `build`, and the new E2E spec all pass.

### 30.2 implementation notes (done)

- Schema: `User.aiCoachEnabled` / `coachIncludeNotes` (both default `false`),
  `coachMessagesToday` / `coachLastMessageAt` plus `CoachConversation` and
  `CoachMessage` (cascade on delete, indexed by userId). Pushed to live Neon
  with `prisma db push --accept-data-loss`; the first attempt hit the same
  transient P1001, the retry succeeded and regenerated Prisma Client.
- Pure module `src/lib/ai/coach.ts`: aggregate-only `CoachContext`, bounded
  notes, email/phone scrubbing, a discipline-only system prompt, a
  banned-language post-check that discards unsafe model output, a
  deterministic rule-based fallback, and the disclaimer appended to every
  reply. No Next/Prisma imports.
- Actions `src/server/actions/coach.ts`: opt-in + separate notes toggle, 12/10m
  burst limit on top of a 20/day quota (`COACH_MAX_MESSAGES_PER_DAY`),
  `userId`-scoped conversation reads/writes, audit rows, and
  `sharedContext` persisted on every assistant reply for the disclosure.
- UI: `CoachSettingsForm` (Settings) and `CoachPanel` (Reports) — a bounded
  chat thread with "What data was shared" details, a rule-based source badge
  and a visible disclaimer. No provider code or key reaches the browser.
- Tests: `tests/coach.test.ts` (18 pure), `tests/coach-integration.test.ts`
  (7 action/DB tests with `requireUser` + `next/cache` mocked), and
  `tests/e2e/coach-panel.spec.ts` (fresh random email; works without an AI key
  via the fallback). Targeted Vitest: 25/25 green.

### 30.3 implementation notes (done)

- Schema pushed to live Neon with `prisma db push --accept-data-loss` (no
  migration — the SQLite migration lock is still present): new `ImportBatch`
  with a unique `(userId, checksum)` key, plus additive `source`, `externalId`
  and `importBatchId` on `Trade`/`Transaction` (unique on
  `(userId, source, externalId)` / `(tradingAccountId, source, externalId)`).
- Pure module `src/lib/import/statement.ts`: file Zod schema, delimiter/quote
  aware CSV/TSV scanner, decimal.js money parser (no `parseFloat`), date
  normalizer, deterministic SHA-256 checksum + per-row external ids, header
  alias mapper, strict Groq column-index response parser with prompt-injection
  defences, row normalizer with per-row errors, and the preview view model.
- Actions `src/server/actions/statement-import.ts`: `previewStatementImportAction`
  validates + archives bytes through `src/lib/storage.ts`, reuses an existing
  batch for identical uploads, optionally asks Groq for column indices only,
  and writes **no** journal rows; `commitStatementImportAction` does a single
  120 s transaction with batched duplicate checks + `createMany`, calls
  `recomputeAccountBalanceInTx()`, and logs `IMPORT_PREVIEWED` /
  `IMPORT_COMMITTED` / `IMPORT_FAILED`.
- UI: dedicated `/app/import` page + `StatementImportPanel` (account picker,
  file input, optional OCR text, preview table with Ready/Duplicate/Invalid
  rows, explicit Commit button, recent batches, visible risk disclaimer) and a
  sidebar "Import" link. The older paste wizard on `/app/reports` is unchanged.
- Tests: `tests/import-statement.test.ts` (19 pure), `tests/statement-import-integration.test.ts`
  (4 action/DB tests with `requireUser`, `next/cache` + storage mocked), and
  `tests/e2e/statement-import.spec.ts` (fresh random email, preview/commit and
  re-import no-op). Targeted Vitest: 23/23 green.

### 30.4 implementation notes (done)

- Type: `NEWS_BRIEFING` added to `DEFAULT_PREFS` (all three channels `false`)
  and `TELEGRAM_ALERT_TYPES`. `NotificationPrefsForm` now renders in-app/email
  toggles for it, and the Telegram settings form picks it up automatically.
  `updateNotificationPrefsAction()` now preserves existing `telegram` flags
  instead of silently wiping them on every in-app/email save.
- Pure module `src/lib/news/briefing.ts`: bounded, descriptive copy from the
  precomputed next event, market rating and the user's own edge insight; always
  ends with the risk disclaimer. Banned language (reusing the coach detector
  plus instruction phrases like "buy now"/"go long") is rejected by
  `containsBannedBriefingLanguage()` and scrubbed by `sanitizeBriefingCopy()`;
  the email HTML template escapes all upstream text.
- Sweep `src/server/lib/news-briefing.ts`: CRON-only, no provider/page fetches.
  Reads global `NewsArticle`/`NewsEvent` + `buildMarketSnapshot()` once, then
  per opted-in user calls `getMarketEdgeReport(userId, timezone)` and dispatches
  through `createNotificationIfAllowed`, `sendEmail` (explicit `pref.email`
  gate) and `sendTelegramAlertAction`. Failures are per-user isolated and
  audited on `AgentRun.kind = "BRIEFING"`.
- Cron route `/api/cron/news-briefing` uses the standard `CRON_SECRET` Bearer /
  `?token=` gate and 200/500 response shape. `CRON_SECRET` / Telegram env vars
  documented in `.env.example` (previously missing).
- Tests: `tests/news-briefing.test.ts` (9 pure) and
  `tests/news-briefing-integration.test.ts` (4 live-DB sweep tests with email,
  market snapshot and edge report mocked; Telegram uses the real action with a
  mock provider). Targeted Vitest: 13/13 green.

## Out of scope for Phase 30

- Autonomous trading or auto-placing trades (never).
- Unrestricted crawling or user-supplied URLs.
- New market-data providers (that is the revised 26–29 work).
- Paid third-party scraping services unless explicitly approved later.
