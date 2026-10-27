# RiskGuard — Security

> Phase 13 deliverable. Documents all security measures in the RiskGuard app.

## Authentication & Authorization

### Auth.js (NextAuth v4) — JWT Session Strategy

- **Session**: JWT (signed cookie, edge-readable). `session.strategy = "jwt"`, 30-day max age.
- **Password hashing**: argon2 (winner of the Password Hashing Competition).
- **Timing-safe verification**: argon2.verify runs against a dummy hash on user-not-found, keeping response time constant (side-channel resistance).
- **Generic error messages**: login always returns "Invalid email or password." — no account enumeration.
- **Email verification**: required before login (the `EMAIL_NOT_VERIFIED` gate in `authorize()`).
- **Password reset**: single-use tokens stored in `PasswordReset` table, 1-hour expiry, marked `usedAt` on redemption.

### Multi-Tenant Isolation (Rule #3)

Every database query includes `userId` in the `where` clause:

- `findFirst({ where: { id, userId } })` — cross-user access returns null.
- `updateMany({ where: { id, userId } })` — cross-user update is a silent no-op (count: 0).
- `deleteMany({ where: { id, userId } })` — cross-user delete is a silent no-op.
- Server actions call `requireUser()` to get `userId` from the session — never from form data.

### Server Actions CSRF Protection

- Next.js 16 Server Actions have built-in CSRF protection via the `Next-Action` header + origin check.
- `next.config.ts → experimental.serverActions.allowedOrigins` allowlists the sandbox gateway domains.
- No arbitrary absolute URLs in `redirect()` callback — only relative or same-origin.

## Rate Limiting

- **Abstraction**: `src/lib/rate-limit.ts` — `RateLimiter` interface with `MemoryRateLimiter` (dev) + `UpstashRateLimiter` (prod).
- **Endpoints rate-limited**:
  - Login: 10 attempts / 10 min per IP+email
  - Register: 5 attempts / 10 min per IP
  - Forgot password: 5 attempts / 10 min per IP+email
  - Reset password: 10 attempts / 10 min per IP
  - Verify email: 10 attempts / 10 min per IP

## Input Validation

- **Zod schemas** (`src/lib/validation.ts`) validate EVERY form input on the server, even when the client also validates.
- Password rules: min 8 chars, upper + lower + digit + special character.
- Money fields: `Decimal` (never `Float` or `number` for persisted values).
- Payout percent: validated as 0..1 fraction.
- File uploads: max 5 MB, only PNG/JPEG/WebP/GIF MIME types.
- SQL injection: Prisma ORM parameterizes all queries — no raw SQL except in the seed script (which is dev-only).

## Security Headers

Configured in `next.config.ts`:

| Header                      | Value                                      | Purpose                     |
| --------------------------- | ------------------------------------------ | --------------------------- |
| `X-Content-Type-Options`    | `nosniff`                                  | Prevent MIME sniffing       |
| `X-Frame-Options`           | `DENY`                                     | Prevent clickjacking        |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`          | Limit referrer leakage      |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=()` | Disable unused browser APIs |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`      | Force HTTPS (HSTS)          |

## Secrets Management

- All secrets loaded from environment variables (`.env` file, not committed).
- `.env.example` documents every required env var.
- `NEXTAUTH_SECRET` required — app fails to start without it.
- Google OAuth credentials (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) — env-gated, provider only registered when both are set.
- Resend API key, Upstash Redis URL/token — env-gated, dev fallbacks provided.
- `CRON_SECRET` — protects the `/api/cron/expire-lockouts` endpoint.

## File Upload Security

- `src/lib/storage.ts` — `StorageProvider` interface.
- Validates: file size (≤5 MB), MIME type (PNG/JPEG/WebP/GIF only).
- Serves uploaded files via `/api/upload/[filename]` route handler — rejects path traversal (`..` or `/` in filename).
- Production: swap to S3/Uploadthing via env vars — same `uploadTradeScreenshot()` interface.

## Middleware (proxy.ts)

- Next.js 16 renamed `middleware.ts` → `proxy.ts`.
- Protects all `/app/*` and `/onboarding` routes — requires a JWT token.
- Redirects authed users away from `/login`, `/register`, `/forgot-password`.
- Redirects un-onboarded users to `/onboarding`.
- Redirects onboarded users away from `/onboarding`.

## Dependency Audit

Run `bun audit` (or `npm audit`) to check for known vulnerabilities. The `bun.lock` lockfile pins all dependency versions. High-severity issues should be resolved before production deployment.

## Future Hardening (Phase 14+)

- `sessionVersion` integer on User — included in JWT. Bumping the counter on password change / logout-everywhere invalidates all outstanding tokens.
- Content Security Policy (CSP) — add a strict CSP header that blocks inline scripts/styles (requires nonce-based CSP for Next.js).
- Sentry error monitoring — `@sentry/nextjs` for automatic error capture + performance monitoring.
- Structured logging — JSON-formatted logs for log aggregation (Datadog, Grafana Loki, etc.).
