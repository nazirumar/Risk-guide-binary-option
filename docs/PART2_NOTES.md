# RiskGuard — Part 2 Schema Notes

> Pre-migration planning document for Phases 16–24. Lists every new model,
> field, enum, or index that each phase will need, so migrations stay clean
> and we don't do multiple `db push --accept-data-loss` runs per phase.

## Current Schema Summary (after Part 1, Phases 0–14)

### Models (17)

| Model               | Purpose                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`              | Root user entity (id, email, name, passwordHash, timezone, baseCurrency, isOnboarded, checklistItems, dailyJournal, notificationPrefs, tradingHours) |
| `Account`           | Auth.js OAuth account linking                                                                                                                        |
| `Authenticator`     | Auth.js WebAuthn                                                                                                                                     |
| `AuthSession`       | JWT session store (unused — JWT strategy, kept for adapter compat)                                                                                   |
| `VerificationToken` | Email verification tokens                                                                                                                            |
| `PasswordReset`     | Password reset tokens                                                                                                                                |
| `TradingAccount`    | Broker accounts (userId, name, broker, currency, type, startingBalance, currentBalance, isArchived)                                                  |
| `Transaction`       | Cash flow (DEPOSIT/WITHDRAWAL/BONUS/ADJUSTMENT, amount, note, occurredAt)                                                                            |
| `Strategy`          | User strategies (name, description, color, isActive)                                                                                                 |
| `Trade`             | Trade journal (asset, direction, stake, payoutPercent, result, profitLoss, balanceAfter, emotion, followedPlan, tags, screenshotUrl)                 |
| `RiskProfile`       | Per-account risk rules (riskPerTrade%, maxDailyLoss%, maxConsecLosses, cooldownMinutes, etc.)                                                        |
| `StakingPlan`       | Saved staking plans (method, config JSON, isDefault)                                                                                                 |
| `TradingSession`    | Trading sessions (startedAt, endedAt, startBalance, endBalance, mood, notes)                                                                         |
| `Goal`              | Profit targets (DAILY/WEEKLY/MONTHLY/BALANCE_TARGET, targetAmount, status)                                                                           |
| `Lockout`           | Trading lockouts (reason, startedAt, expiresAt, overriddenAt, overrideReason)                                                                        |
| `Notification`      | In-app notifications (type, title, body, readAt)                                                                                                     |
| `AuditLog`          | Audit trail (action, entity, entityId, meta JSON)                                                                                                    |

### Enums (10)

AccountType, TransactionType, TradeDirection, TradeResult, TradeEmotion, StakingMethod, GoalType, GoalStatus, LockoutReason, TradingSessionMood

---

## Phase 16 — Tilt & Revenge-Trade Detection

**Goal**: Detect when a trader is tilting (emotional after losses) and flag revenge trades before they're saved.

### New fields on existing models

| Model         | Field                  | Type        | Notes                                                                                                |
| ------------- | ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `User`        | `tiltScore`            | `Decimal?`  | 0–100 composite score (loss streak + emotion + time-of-day + stake deviation). Higher = more tilted. |
| `User`        | `lastTiltAt`           | `DateTime?` | When tilt was last detected. Used for cooldown logic.                                                |
| `RiskProfile` | `tiltDetectionEnabled` | `Boolean`   | Default `true`. Whether to show tilt warnings.                                                       |
| `RiskProfile` | `tiltThreshold`        | `Decimal?`  | Score above which the trader is considered "tilted" (default 60).                                    |

### New model

```prisma
model TiltEvent {
  id        String   @id @default(cuid())
  userId    String
  trigger   String   // "CONSEC_LOSSES" | "STAKE_INCREASE" | "REVENGE_EMOTION" | "RAPID_TRADING"
  score     Decimal
  context   Json     // { lossStreak, avgStakeVsNormal, timeSinceLastTrade, emotion }
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
}
```

### Migration notes

- 3 new nullable fields on User (safe `ALTER TABLE ADD COLUMN` on SQLite).
- 2 new fields on RiskProfile (Boolean default + Decimal? — safe).
- 1 new model (TiltEvent) — clean `CREATE TABLE`.
- **Single migration**: all of the above in one `db push`.

---

## Phase 17 — Pre-Trade Confirmation Screen

**Goal**: A confirmation modal that shows risk metrics before a trade is opened — especially after tilt or when stake exceeds limits.

### Actual schema (as implemented)

| Model  | Field                         | Type                                    | Notes                                                                        |
| ------ | ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `User` | `preTradeConfirmSkipDemo`     | `Boolean` (default false)               | Skip the confirmation screen on DEMO accounts. REAL accounts always confirm. |
| `User` | `preTradeCooldownSeconds`     | `Int` (default 5)                       | 0–15s server-enforced cooldown before "Confirm trade" unlocks.               |
| `User` | `preTradeRequirePlanCheckbox` | `Boolean` (default false)               | Require the "This trade follows my plan" checkbox (saved as followedPlan).   |
| `User` | `preTradeReasonMode`          | `PreTradeReasonMode` (default OPTIONAL) | OFF / OPTIONAL / REQUIRED quick "reason for entry" in the modal.             |

### New model

```prisma
model CancelledTradeAttempt {
  id        String   @id @default(cuid())
  userId    String
  stake     Decimal
  asset     String
  reason    String?  // optional free-text captured at cancel time
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
}
```

### New enum

`PreTradeReasonMode { OFF OPTIONAL REQUIRED }`

### Migration notes

- 4 non-null fields with defaults on User (safe `ALTER TABLE ADD COLUMN`).
- 1 new model (CancelledTradeAttempt) — clean `CREATE TABLE`.

---

## Phase 18 — Broker Balance Sync Checks

**Goal**: Periodically check if the app's computed balance matches the broker's real balance, and surface discrepancies.

### New model

```prisma
model BrokerSync {
  id               String   @id @default(cuid())
  userId           String
  tradingAccountId String
  expectedBalance  Decimal  // our computed balance
  actualBalance    Decimal?  // broker's balance (null = not yet checked)
  difference       Decimal?  // actual - expected
  status           String   // "MATCH" | "MISMATCH" | "PENDING"
  syncedAt         DateTime @default(now())
  user             User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  tradingAccount   TradingAccount @relation(fields: [tradingAccountId], references: [id], onDelete: Cascade)
  @@index([userId, syncedAt])
  @@index([tradingAccountId, syncedAt])
}
```

### Relation additions

| Model            | New relation               |
| ---------------- | -------------------------- |
| `User`           | `brokerSyncs BrokerSync[]` |
| `TradingAccount` | `brokerSyncs BrokerSync[]` |

### Migration notes

- 1 new model + 2 relation additions. Clean `CREATE TABLE`.
- The existing `Transaction` model with `type = ADJUSTMENT` already handles the correction — `BrokerSync` just tracks the check history.

---

## Phase 19 — Withdrawal Rules & Profit-Taking

**Goal**: Automated withdrawal rules — when balance hits a target, suggest/create a withdrawal.

### New model

```prisma
model WithdrawalRule {
  id               String   @id @default(cuid())
  userId           String
  tradingAccountId String
  trigger          String   // "BALANCE_TARGET" | "PROFIT_PERCENT" | "DAILY_PROFIT_TARGET" | "WEEKLY_PROFIT"
  threshold        Decimal  // amount or percentage
  action           String   // "NOTIFY" | "AUTO_CREATE_WITHDRAWAL"
  isActive         Boolean  @default(true)
  lastTriggeredAt  DateTime?
  createdAt        DateTime @default(now())
  user             User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  tradingAccount   TradingAccount @relation(fields: [tradingAccountId], references: [id], onDelete: Cascade)
  @@index([userId, isActive])
}
```

### Relation additions

| Model            | New relation                       |
| ---------------- | ---------------------------------- |
| `User`           | `withdrawalRules WithdrawalRule[]` |
| `TradingAccount` | `withdrawalRules WithdrawalRule[]` |

### Migration notes

- 1 new model + 2 relation additions. Clean `CREATE TABLE`.
- The `Transaction` model with `type = WITHDRAWAL` already handles the actual withdrawal record.

---

## Phase 20 — Strategy Validation (Statistical Reliability)

**Goal**: Compute + cache statistical reliability metrics for each strategy, so the trader knows which strategies have enough sample size + positive expectancy.

### New fields on Strategy

| Field                | Type        | Notes                                                            |
| -------------------- | ----------- | ---------------------------------------------------------------- |
| `totalTrades`        | `Int`       | Default 0. Cached count.                                         |
| `winRate`            | `Decimal?`  | Cached win rate (0–1).                                           |
| `expectancyPerTrade` | `Decimal?`  | Cached expectancy.                                               |
| `profitFactor`       | `Decimal?`  | Cached profit factor.                                            |
| `isValidated`        | `Boolean`   | Default false. True when sample size ≥ 30 + positive expectancy. |
| `lastValidatedAt`    | `DateTime?` | When stats were last recomputed.                                 |

### Migration notes

- 6 new fields on Strategy. All nullable or have defaults — safe `ALTER TABLE ADD COLUMN`.
- **No new models** — the cached stats are computed by the Phase 6 calc engine (`computeStats` per strategy group).
- Add an index: `@@index([userId, isValidated])`.

---

## Phase 21 — Discipline Score & Streaks

**Goal**: A composite "discipline score" (0–100) that weights plan-following, emotional state, risk adherence, and consistency.

### New fields on User

| Field                      | Type        | Notes                                     |
| -------------------------- | ----------- | ----------------------------------------- |
| `disciplineScore`          | `Decimal?`  | 0–100 composite. Null = not yet computed. |
| `disciplineScoreUpdatedAt` | `DateTime?` | When the score was last recomputed.       |

### New model (for score history charting)

```prisma
model DisciplineScoreHistory {
  id        String   @id @default(cuid())
  userId    String
  score     Decimal
  breakdown Json  // { planFollowed: number, emotionPenalty: number, riskAdherence: number, consistency: number }
  computedAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, computedAt])
}
```

### Migration notes

- 2 nullable fields on User + 1 new model + 1 relation. Safe.
- The score is computed by the Phase 6 calc engine (followed-plan rate, emotion breakdown, risk-rule adherence rate, consistency score).

---

## Phase 22 — Session/Hours Analysis & News Calendar

**Goal**: Analyze performance by trading hours + integrate an economic news calendar.

### New model

```prisma
model NewsEvent {
  id          String   @id @default(cuid())
  asset       String   // "EUR/USD" or "*" for all
  title       String
  impact      String   // "LOW" | "MEDIUM" | "HIGH"
  scheduledAt DateTime
  source      String   // "ForexFactory" | "Investing" | "Custom"
  url         String?
  createdAt   DateTime @default(now())
  @@index([scheduledAt])
  @@index([asset, scheduledAt])
}
```

### Migration notes

- 1 new model. No relation to User (news events are global).
- No fields on existing models — the session analysis uses the existing `TradingSession` model + `User.tradingHours`.
- Add a cron or manual sync endpoint to fetch news events from a public API.

---

## Phase 23 — Telegram Alerts & AI Weekly Review

**Goal**: Send alerts via Telegram bot + generate an AI-powered weekly review summary.

### New fields on User

| Field                   | Type       | Notes                                                      |
| ----------------------- | ---------- | ---------------------------------------------------------- |
| `telegramChatId`        | `String?`  | Telegram chat ID for the user's bot. Null = not connected. |
| `telegramAlertsEnabled` | `Boolean?` | Default false. Whether to send alerts via Telegram.        |

### New model (for caching AI reviews)

```prisma
model WeeklyReview {
  id         String   @id @default(cuid())
  userId    String
  weekStart DateTime
  weekEnd   DateTime
  summary   String   // AI-generated plain-language review
  metrics   Json     // { netPL, winRate, profitFactor, bestAsset, worstAsset, breaches }
  generatedAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, weekStart])
  @@unique([userId, weekStart])
}
```

### Migration notes

- 2 nullable fields on User + 1 new model + 1 relation. Safe.
- Telegram bot token stored as env var (`TELEGRAM_BOT_TOKEN`), not in the DB.
- AI review uses the z-ai-web-dev-sdk LLM skill (already installed) or an external API.

---

## Phase 24 — Billing (Paystack/Stripe) & Plans

**Goal**: Subscription billing with Free/Pro/Elite plans via Paystack (Africa) or Stripe (global).

### New enum

```prisma
enum SubscriptionPlan {
  FREE
  PRO
  ELITE
}

enum SubscriptionStatus {
  ACTIVE
  TRIALING
  PAST_DUE
  CANCELLED
  EXPIRED
}

enum PaymentProvider {
  PAYSTACK
  STRIPE
}
```

### New models

```prisma
model Subscription {
  id                    String             @id @default(cuid())
  userId                String
  plan                  SubscriptionPlan   @default(FREE)
  status                SubscriptionStatus @default(ACTIVE)
  paymentProvider       PaymentProvider?
  providerCustomerId    String?
  providerSubscriptionId String?
  currentPeriodStart    DateTime?
  currentPeriodEnd     DateTime?
  cancelledAt          DateTime?
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt
  user                  User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, status])
}

model Payment {
  id                    String           @id @default(cuid())
  userId                String
  amount                Decimal
  currency              String           @default("USD")
  provider              PaymentProvider
  providerPaymentId     String?
  status                String           // "PENDING" | "SUCCESS" | "FAILED"
  invoiceUrl            String?
  createdAt             DateTime         @default(now())
  user                  User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
}
```

### New fields on User

| Field            | Type      | Notes                                       |
| ---------------- | --------- | ------------------------------------------- |
| `subscriptionId` | `String?` | FK to Subscription (optional — one-to-one). |

### Relation additions

| Model  | New relation                                                 |
| ------ | ------------------------------------------------------------ |
| `User` | `subscription Subscription?` (one-to-one via subscriptionId) |
| `User` | `payments Payment[]`                                         |

### Migration notes

- 3 new enums + 2 new models + 2 new fields on User. Largest migration in Part 2.
- **Do this migration FIRST** (before Phase 24 starts) so the models are ready when the billing code is written.
- Paystack/Stripe webhook handlers go in `/api/webhooks/paystack` and `/api/webhooks/stripe`.
- Feature gates check `subscription.plan` to show/hide Pro/Elite features.

---

## Migration Schedule (recommended order)

| Phase | New models             | New fields on existing            | Migration complexity         |
| ----- | ---------------------- | --------------------------------- | ---------------------------- |
| 16    | TiltEvent              | User (2) + RiskProfile (2)        | Low — safe ALTER TABLE       |
| 17    | —                      | User (1)                          | Trivial — 1 nullable Boolean |
| 18    | BrokerSync             | User + TradingAccount (relations) | Low — 1 new table            |
| 19    | WithdrawalRule         | User + TradingAccount (relations) | Low — 1 new table            |
| 20    | —                      | Strategy (6)                      | Low — safe ALTER TABLE       |
| 21    | DisciplineScoreHistory | User (2)                          | Low — 1 new table + 2 fields |
| 22    | NewsEvent              | —                                 | Low — 1 new global table     |
| 23    | WeeklyReview           | User (2)                          | Low — 1 new table + 2 fields |
| 24    | Subscription + Payment | User (1) + 3 enums                | Medium — largest migration   |

**Total new models**: 7 (TiltEvent, BrokerSync, WithdrawalRule, DisciplineScoreHistory, NewsEvent, WeeklyReview, Subscription, Payment)
**Total new fields**: ~15 on existing models
**Total new enums**: 3 (SubscriptionPlan, SubscriptionStatus, PaymentProvider)

### Strategy: batch migrations where possible

- Phases 16+17 can share one migration (both add nullable fields to User).
- Phases 18+19 can share one migration (both add a new model with User+TradingAccount relations).
- Phase 24 gets its own migration (largest, most complex).
- Each phase that adds a new model should verify the `db push` doesn't break existing data (use `--accept-data-loss` only when truly necessary — SQLite table recreation).
