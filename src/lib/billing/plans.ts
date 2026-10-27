/**
 * Phase 24 — Plan definitions + limits (single source of truth).
 *
 * (PROJECT_RULES.md rule #2: all calculations live in /src/lib as pure,
 * unit-tested functions. rule #12: Martingale-style staking may exist as
 * an option but must always show a red warning and be OFF by default.)
 *
 * Two plans per the user spec:
 *   - FREE: 1 trading account, 100 trades/month, basic analytics.
 *   - PRO: unlimited accounts + trades, tilt detection, Telegram, AI
 *     review, exports, advanced analytics.
 *
 * Limits are configurable here — changing a number updates the gating
 * across the whole app. The `requirePlan` helper checks against these.
 */

export type PlanKey = "FREE" | "PRO";

export type PlanFeature =
  | "tilt-detection"
  | "telegram"
  | "ai-review"
  | "exports"
  | "advanced-analytics"
  | "withdrawal-rules"
  | "balance-sync"
  | "discipline-score"
  | "strategy-validation"
  | "sessions-news";

export type PlanConfig = {
  key: PlanKey;
  label: string;
  description: string;
  /** Max trading accounts. null = unlimited. */
  maxAccounts: number | null;
  /** Max trades per calendar month. null = unlimited. */
  maxTradesPerMonth: number | null;
  /** Feature flags gated by this plan. */
  features: PlanFeature[];
  /** Monthly price in the billing currency (NGN for Paystack, USD for Stripe). */
  monthlyPriceNGN: number;
  monthlyPriceUSD: number;
};

export const PLAN_CONFIGS: Record<PlanKey, PlanConfig> = {
  FREE: {
    key: "FREE",
    label: "Free",
    description:
      "1 trading account, 100 trades per month, basic analytics. Perfect for getting started with discipline tracking.",
    maxAccounts: 1,
    maxTradesPerMonth: 100,
    features: ["balance-sync"], // balance sync is available on FREE
    monthlyPriceNGN: 0,
    monthlyPriceUSD: 0,
  },
  PRO: {
    key: "PRO",
    label: "Pro",
    description:
      "Unlimited accounts + trades, tilt detection, Telegram alerts, AI weekly review, exports, advanced analytics, withdrawal rules, sessions + news calendar.",
    maxAccounts: null,
    maxTradesPerMonth: null,
    features: [
      "tilt-detection",
      "telegram",
      "ai-review",
      "exports",
      "advanced-analytics",
      "withdrawal-rules",
      "balance-sync",
      "discipline-score",
      "strategy-validation",
      "sessions-news",
    ],
    monthlyPriceNGN: 15000, // ~$10 USD
    monthlyPriceUSD: 10,
  },
};

/**
 * The grace period in days for failed payments (per spec: 3 days).
 * After this period, a PAST_DUE subscription is downgraded to FREE.
 */
export const GRACE_PERIOD_DAYS = 3;

/**
 * Check whether a plan has a specific feature.
 */
export function hasFeature(plan: PlanKey, feature: PlanFeature): boolean {
  return PLAN_CONFIGS[plan].features.includes(feature);
}

/**
 * Check whether the user can create another trading account.
 */
export function canCreateAccount(plan: PlanKey, currentCount: number): boolean {
  const max = PLAN_CONFIGS[plan].maxAccounts;
  return max == null || currentCount < max;
}

/**
 * Check whether the user can save another trade this month.
 */
export function canSaveTrade(plan: PlanKey, tradesThisMonth: number): boolean {
  const max = PLAN_CONFIGS[plan].maxTradesPerMonth;
  return max == null || tradesThisMonth < max;
}
