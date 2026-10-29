/**
 * Zod schemas for auth flows (PROJECT_RULES.md rule #4: validate on the server,
 * even if the client validates too).
 *
 * Password rules: min 8 / max 100 chars, must include upper + lower + digit +
 * special char. Same rules applied everywhere a password is created or changed.
 */
import { z } from "zod";

const passwordShape = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(100, "Password must be at most 100 characters")
  .regex(/[A-Z]/, "Password must include at least one uppercase letter")
  .regex(/[a-z]/, "Password must include at least one lowercase letter")
  .regex(/[0-9]/, "Password must include at least one digit")
  .regex(/[^A-Za-z0-9]/, "Password must include at least one special character");

export const passwordSchema = passwordShape;

export const registerSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100, "Name is too long"),
    email: z.string().email("Enter a valid email"),
    password: passwordShape,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, {
      message: "You must accept the risk disclaimer and terms",
    }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email"),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: passwordShape,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const verifyEmailSchema = z.object({
  token: z.string().min(1, "Verification token is required"),
});

// Onboarding wizard — 3 steps. Each step is validated independently, then
// the combined payload is validated server-side via this schema.
export const onboardingSchema = z.object({
  // Step 1: locale
  baseCurrency: z.string().length(3, "Use a 3-letter currency code (e.g. USD)"),
  timezone: z.string().min(1, "Pick a timezone"),
  // Step 2: first trading account
  accountName: z.string().min(1, "Account name is required").max(100),
  broker: z.string().min(1, "Broker name is required").max(100),
  accountType: z.enum(["DEMO", "REAL"]),
  startingBalance: z
    .number()
    .min(0, "Starting balance cannot be negative")
    .max(10_000_000, "Starting balance is too large"),
  // Step 3: risk profile (defaults seeded into the form)
  riskPerTradePercent: z.number().min(0.1).max(50),
  maxDailyLossPercent: z.number().min(0.1).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(20),
});

// Profile edits
export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100),
  timezone: z.string().min(1),
  baseCurrency: z.string().length(3),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordShape,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

// Phase 25: "Set a password" flow for Google-only users (no passwordHash).
// currentPassword is optional — required only when the user already has a
// passwordHash (the regular change-password flow). When the user has no
// passwordHash, currentPassword is ignored server-side.
export const setPasswordSchema = z
  .object({
    currentPassword: z.string().optional(),
    newPassword: passwordShape,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

// Phase 25: Disconnect a Google Account. Requires re-auth confirmation:
// either the user's current password (for password users) or a fresh
// Google re-sign-in token (for Google-only users — but the spec says
// disconnect is BLOCKED for Google-only users until they set a password,
// so the only path here is: password user disconnecting their linked
// Google account). providerAccountId is required so we know which to
// remove (future-proofing for multi-OAuth-provider).
export const unlinkAccountSchema = z.object({
  provider: z.string().min(1, "Provider is required"),
  providerAccountId: z.string().min(1, "Provider account id is required"),
  confirmPassword: z.string().min(1, "Confirm your password to disconnect"),
});

// Phase 25: Sign out of all devices — no body, but we accept a confirmation
// password for the re-auth requirement (spec point 7: "Re-authentication
// before disconnecting or deleting the account"). Sign-out-of-all is also
// sensitive — re-auth protects against drive-by session hijack → mass logout.
export const signOutAllSchema = z.object({
  confirmPassword: z.string().optional(),
});

export const deleteAccountSchema = z.object({
  confirmPhrase: z.literal("DELETE MY ACCOUNT", {
    message: "Type DELETE MY ACCOUNT exactly to confirm",
  }),
});

// ─── Phase 4: Trading Accounts + Transactions + Reconcile ───────────────

export const createTradingAccountSchema = z.object({
  name: z.string().min(1, "Account name is required").max(100, "Name is too long"),
  broker: z.string().min(1, "Broker is required").max(100),
  currency: z.string().length(3, "Use a 3-letter currency code (e.g. USD)"),
  type: z.enum(["DEMO", "REAL"]),
  startingBalance: z
    .number()
    .min(0, "Starting balance cannot be negative")
    .max(10_000_000, "Starting balance is too large"),
});

export const updateTradingAccountSchema = createTradingAccountSchema.partial({
  startingBalance: true,
  type: true,
});

export const createTransactionSchema = z.object({
  tradingAccountId: z.string().min(1),
  type: z.enum(["DEPOSIT", "WITHDRAWAL", "BONUS", "ADJUSTMENT"]),
  amount: z
    .number({ message: "Amount must be a number" })
    .refine((v) => Number.isFinite(v), "Amount must be a number")
    .refine((v) => v !== 0, "Amount cannot be zero")
    .refine((v) => Math.abs(v) < 10_000_000, "Amount is too large"),
  note: z.string().max(500, "Note is too long").optional(),
  occurredAt: z.string().or(z.date()).optional(),
});

export const reconcileBalanceSchema = z.object({
  tradingAccountId: z.string().min(1),
  brokerBalance: z
    .number({ message: "Broker balance must be a number" })
    .refine((v) => Number.isFinite(v), "Broker balance must be a number")
    .refine((v) => v >= 0, "Broker balance cannot be negative"),
  note: z.string().max(500, "Note is too long").optional(),
});

// ─── Phase 5: Trade Journal ─────────────────────────────────────────────

export const tradeDirectionSchema = z.enum(["CALL", "PUT"]);
export const tradeResultSchema = z.enum(["WIN", "LOSS", "TIE", "OPEN"]);
export const tradeEmotionSchema = z.enum([
  "CALM",
  "CONFIDENT",
  "FEARFUL",
  "GREEDY",
  "REVENGE",
  "TIRED",
  "BORED",
]);

export const createTradeSchema = z.object({
  tradingAccountId: z.string().min(1),
  asset: z.string().min(1, "Asset is required").max(50, "Asset is too long"),
  direction: tradeDirectionSchema,
  stake: z
    .number({ message: "Stake must be a number" })
    .refine((v) => Number.isFinite(v), "Stake must be a number")
    .refine((v) => v > 0, "Stake must be positive")
    .refine((v) => v < 10_000_000, "Stake is too large"),
  payoutPercent: z
    .number({ message: "Payout % must be a number" })
    .refine((v) => Number.isFinite(v), "Payout % must be a number")
    .refine((v) => v >= 0 && v <= 1, "Payout % must be between 0 and 1 (e.g. 0.85 for 85%)"),
  expiryMinutes: z
    .number({ message: "Expiry must be a number" })
    .int("Expiry must be a whole number of minutes")
    .min(1, "Expiry must be at least 1 minute")
    .max(1440, "Expiry cannot exceed 24 hours (1440 minutes)"),
  strategyId: z.string().optional().nullable(),
  timeframe: z.string().max(20).optional().nullable(),
  emotion: tradeEmotionSchema.optional().nullable(),
  followedPlan: z.boolean().default(true),
  setupNotes: z.string().max(2000, "Notes too long").optional().nullable(),
  screenshotUrl: z.string().max(10_000_000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20, "Max 20 tags").default([]),
  // ── Phase 17: pre-trade confirmation ──
  /** HMAC-signed token from prepareTradeConfirmationAction. Required by
   *  createTradeAction whenever the confirmation screen applies. */
  confirmationToken: z.string().max(4096).optional(),
  /** Quick "reason for entry" typed in the confirmation modal (merged into
   *  setupNotes; mandatory when the user's settings say REQUIRED). */
  entryReason: z.string().max(500, "Reason is too long").optional().nullable(),
  // ── Phase 29: market-rating warning ──
  /** True when the trader pressed "Continue" on the AVOID confirmation
   *  dialog. The server re-verifies the rating before storing it — the flag
   *  is metadata (feeds the discipline deduction), never a block. */
  ignoredAvoidWarning: z.boolean().default(false),
});

export const closeTradeSchema = z.object({
  tradeId: z.string().min(1),
  result: z.enum(["WIN", "LOSS", "TIE"], {
    message: "Result must be WIN, LOSS, or TIE",
  }),
});

export const updateTradeSchema = createTradeSchema.partial().extend({
  tradeId: z.string().min(1),
  result: tradeResultSchema.optional(),
});

export const deleteTradeSchema = z.object({
  tradeId: z.string().min(1),
});

export const bulkDeleteTradesSchema = z.object({
  tradeIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one trade")
    .max(500, "Max 500 at a time"),
});

// ─── Phase 7: Risk Rules + Lockouts ──────────────────────────────────────

export const upsertRiskProfileSchema = z.object({
  tradingAccountId: z.string().min(1),
  riskPerTradePercent: z.number().min(0.1).max(50),
  maxDailyLossPercent: z.number().min(0.1).max(100),
  maxDailyLossAmount: z.number().min(0).optional().nullable(),
  dailyProfitTargetPercent: z.number().min(0).max(100).optional().nullable(),
  maxTradesPerDay: z.number().int().min(1).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(20),
  cooldownMinutes: z.number().int().min(0).max(1440),
  maxOpenTrades: z.number().int().min(1).max(20),
  weeklyLossLimitPercent: z.number().min(0).max(100).optional().nullable(),
  lockoutEnabled: z.boolean(),
});

export const manualLockoutSchema = z.object({
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  reason: z.string().max(500).optional(),
});

export const overrideLockoutSchema = z.object({
  lockoutId: z.string().min(1),
  confirmationPhrase: z.literal("I understand the risk", {
    message: "Type 'I understand the risk' exactly to confirm",
  }),
  overrideReason: z.string().min(5, "Reason must be at least 5 characters").max(500),
});

// ─── Phase 17: Pre-trade confirmation ────────────────────────────────────

export const preTradeReasonModeSchema = z.enum(["OFF", "OPTIONAL", "REQUIRED"]);

export const preTradeSettingsSchema = z.object({
  /** Skip the confirmation screen on DEMO accounts. REAL accounts always confirm. */
  skipDemo: z.boolean(),
  /** Seconds the Confirm button stays disabled (0–15). Enforced server-side. */
  cooldownSeconds: z
    .number({ message: "Cooldown must be a number" })
    .int("Cooldown must be a whole number of seconds")
    .min(0, "Cooldown cannot be negative")
    .max(15, "Cooldown cannot exceed 15 seconds"),
  /** Require the "This trade follows my plan" checkbox before confirming. */
  requirePlanCheckbox: z.boolean(),
  /** Whether the modal asks for a quick "reason for entry". */
  reasonMode: preTradeReasonModeSchema,
});

export const cancelTradeAttemptSchema = z.object({
  stake: z
    .number({ message: "Stake must be a number" })
    .refine((v) => Number.isFinite(v), "Stake must be a number")
    .refine((v) => v > 0, "Stake must be positive")
    .refine((v) => v < 10_000_000, "Stake is too large"),
  asset: z.string().min(1, "Asset is required").max(50, "Asset is too long"),
  reason: z.string().max(500, "Reason is too long").optional().nullable(),
});

// ─── Phase 29: Market-rating warnings ────────────────────────────────────

export const marketWarningSettingsSchema = z.object({
  /** Show the live GOOD/CAUTION/AVOID warnings in the Add Trade flow. */
  warningsEnabled: z.boolean(),
  /** Skip the AVOID confirm dialog on DEMO accounts (badge still shows). */
  ignoreAvoidOnDemo: z.boolean(),
  /** Discipline weight (0–10) lost when an AVOID warning is ignored. 0 = off. */
  avoidOverrideWeight: z
    .number({ message: "Weight must be a number" })
    .int("Weight must be a whole number")
    .min(0, "Weight cannot be negative")
    .max(10, "Weight cannot exceed 10"),
});

// ─── Phase 18: Broker Balance Sync Checks ───────────────────────────────

export const balanceCheckResolutionSchema = z.enum(["MATCHED", "ADJUSTED", "IGNORED"]);
export const balanceSyncReminderFrequencySchema = z.enum(["DAILY", "WEEKLY", "OFF"]);

/**
 * Schema for the "create a balance check" action. The user enters the real
 * broker balance; the server reads the app's current balance and computes the
 * difference. `note` is optional and only persisted when the resolution is
 * IGNORED (or saved as the audit-log note on ADJUSTED).
 */
export const createBalanceCheckSchema = z.object({
  tradingAccountId: z.string().min(1, "Account is required"),
  brokerBalance: z
    .number({ message: "Broker balance must be a number" })
    .refine((v) => Number.isFinite(v), "Broker balance must be a number")
    .refine((v) => v >= 0, "Broker balance cannot be negative")
    .refine((v) => v < 1_000_000_000, "Broker balance is too large"),
});

/**
 * Schema for resolving a pending balance check. `resolution` is the action
 * the user picked from the dialog: ADJUSTED creates an ADJUSTMENT
 * transaction atomically and re-runs the balance recompute; IGNORED just
 * stamps the note + resolution on the row. MATCHED is terminal and never
 * sent here (the check auto-resolves MATCHED on creation).
 */
export const resolveBalanceCheckSchema = z.object({
  checkId: z.string().min(1, "Check id is required"),
  resolution: z.enum(["ADJUSTED", "IGNORED"], {
    message: "Resolution must be ADJUSTED or IGNORED",
  }),
  note: z.string().max(500, "Note is too long").optional().nullable(),
});

/**
 * Schema for the per-user sync settings. Tolerance is a percent (0–100);
 * the default 0.5 means 0.5%. Reminder frequency DAILY/WEEKLY/OFF controls
 * the dashboard banner prompt.
 */
export const balanceSyncSettingsSchema = z.object({
  tolerancePercent: z
    .number({ message: "Tolerance must be a number" })
    .refine((v) => Number.isFinite(v), "Tolerance must be a number")
    .min(0, "Tolerance cannot be negative")
    .max(100, "Tolerance cannot exceed 100%"),
  reminderFrequency: balanceSyncReminderFrequencySchema,
});

// ─── Phase 19: Withdrawal Rules & Profit-Taking ──────────────────────────

export const withdrawalRuleTypeSchema = z.enum([
  "PERCENT_OF_PROFIT",
  "FIXED_AMOUNT",
  "BALANCE_ABOVE_THRESHOLD",
]);
export const withdrawalFrequencySchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
export const withdrawalBaselineSchema = z.enum([
  "STARTING_BALANCE",
  "LAST_WITHDRAWAL",
  "HIGH_WATER_MARK",
]);

export const createWithdrawalRuleSchema = z.object({
  tradingAccountId: z.string().min(1, "Account is required"),
  type: withdrawalRuleTypeSchema,
  value: z
    .number({ message: "Value must be a number" })
    .refine((v) => Number.isFinite(v), "Value must be a number")
    .refine((v) => v >= 0, "Value cannot be negative")
    .refine((v) => v < 1_000_000_000, "Value is too large"),
  frequency: withdrawalFrequencySchema,
  baseline: withdrawalBaselineSchema,
  isActive: z.boolean().default(true),
});

export const updateWithdrawalRuleSchema = createWithdrawalRuleSchema.partial().extend({
  ruleId: z.string().min(1, "Rule id is required"),
});

/** Schema for the "Mark as withdrawn" action — creates a WITHDRAWAL
 *  transaction atomically. ruleId is optional because the user may withdraw
 *  ad-hoc (no rule attached); when present, the rule's lastTriggeredAt is
 *  stamped so the cron skips it for the rest of the frequency window. */
export const markWithdrawnSchema = z.object({
  ruleId: z.string().min(1).optional(),
  tradingAccountId: z.string().min(1, "Account is required"),
  amount: z
    .number({ message: "Amount must be a number" })
    .refine((v) => Number.isFinite(v), "Amount must be a number")
    .refine((v) => v > 0, "Amount must be positive")
    .refine((v) => v < 1_000_000_000, "Amount is too large"),
  note: z.string().max(500, "Note is too long").optional(),
});

/** Schema for the optional big-win-day settings (Phase 19). null = disabled;
 *  otherwise todayPL/balance >= this percent triggers a "stop trading and
 *  bank profit" prompt. */
export const bigWinDaySettingsSchema = z.object({
  bigWinDayPercent: z
    .number({ message: "Threshold must be a number" })
    .refine((v) => Number.isFinite(v), "Threshold must be a number")
    .min(0, "Threshold cannot be negative")
    .max(1000, "Threshold cannot exceed 1000%")
    .nullable(),
});

export type PreTradeSettingsInput = z.infer<typeof preTradeSettingsSchema>;
export type PreTradeReasonMode = z.infer<typeof preTradeReasonModeSchema>;
export type CancelTradeAttemptInput = z.infer<typeof cancelTradeAttemptSchema>;
export type BalanceCheckResolution = z.infer<typeof balanceCheckResolutionSchema>;
export type BalanceSyncReminderFrequency = z.infer<typeof balanceSyncReminderFrequencySchema>;
export type CreateBalanceCheckInput = z.infer<typeof createBalanceCheckSchema>;
export type ResolveBalanceCheckInput = z.infer<typeof resolveBalanceCheckSchema>;
export type BalanceSyncSettingsInput = z.infer<typeof balanceSyncSettingsSchema>;
export type WithdrawalRuleType = z.infer<typeof withdrawalRuleTypeSchema>;
export type WithdrawalFrequency = z.infer<typeof withdrawalFrequencySchema>;
export type WithdrawalBaseline = z.infer<typeof withdrawalBaselineSchema>;
export type CreateWithdrawalRuleInput = z.infer<typeof createWithdrawalRuleSchema>;
export type UpdateWithdrawalRuleInput = z.infer<typeof updateWithdrawalRuleSchema>;
export type MarkWithdrawnInput = z.infer<typeof markWithdrawnSchema>;
export type BigWinDaySettingsInput = z.infer<typeof bigWinDaySettingsSchema>;

export type CreateTradeInput = z.infer<typeof createTradeSchema>;
export type CloseTradeInput = z.infer<typeof closeTradeSchema>;
export type UpdateTradeInput = z.infer<typeof updateTradeSchema>;
export type DeleteTradeInput = z.infer<typeof deleteTradeSchema>;
export type BulkDeleteTradesInput = z.infer<typeof bulkDeleteTradesSchema>;

export type CreateTradingAccountInput = z.infer<typeof createTradingAccountSchema>;
export type UpdateTradingAccountInput = z.infer<typeof updateTradingAccountSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type ReconcileBalanceInput = z.infer<typeof reconcileBalanceSchema>;

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type OnboardingInput = z.infer<typeof onboardingSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type UnlinkAccountInput = z.infer<typeof unlinkAccountSchema>;
export type SignOutAllInput = z.infer<typeof signOutAllSchema>;
