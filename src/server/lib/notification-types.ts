/**
 * Notification types + constants — kept outside the "use server" file because
 * Next.js 16's Turbopack requires "use server" files to export ONLY async
 * functions. Type exports and const exports are flagged as "found object".
 */

export type NotificationPrefs = Record<
  string,
  { inApp: boolean; email: boolean; telegram?: boolean }
>;

export const DEFAULT_PREFS: NotificationPrefs = {
  RISK_LIMIT_80: { inApp: true, email: true, telegram: true },
  RISK_LIMIT_100: { inApp: true, email: true, telegram: true },
  LOCKOUT_STARTED: { inApp: true, email: false, telegram: true },
  LOCKOUT_ENDED: { inApp: true, email: false, telegram: true },
  GOAL_ACHIEVED: { inApp: true, email: true, telegram: true },
  WEEKLY_SUMMARY: { inApp: true, email: true, telegram: false },
  INACTIVITY: { inApp: true, email: false, telegram: false },
  // Phase 19 — Withdrawal rules & profit-taking
  WITHDRAWAL_DUE: { inApp: true, email: true, telegram: true },
  BIG_WIN_DAY: { inApp: true, email: false, telegram: false },
  // Phase 23 — Telegram alerts & AI weekly review
  TILT_WARNING: { inApp: true, email: false, telegram: true },
  DAILY_SUMMARY: { inApp: false, email: false, telegram: true },
  AI_WEEKLY_REVIEW: { inApp: true, email: false, telegram: false },
  // Phase 28 — Live market conditions. OFF by default (spec: "optional alerts …
  // off by default"); the worker only notifies users who opt in AND favor a pair.
  MARKET_CONDITION_CHANGED: { inApp: false, email: false, telegram: false },
};

/**
 * The list of alert types that support the Telegram channel (Phase 23).
 * The Settings UI renders a toggle per type.
 */
export const TELEGRAM_ALERT_TYPES = [
  "RISK_LIMIT_80",
  "RISK_LIMIT_100",
  "LOCKOUT_STARTED",
  "LOCKOUT_ENDED",
  "TILT_WARNING",
  "WITHDRAWAL_DUE",
  "GOAL_ACHIEVED",
  "DAILY_SUMMARY",
] as const;

export type TelegramAlertType = (typeof TELEGRAM_ALERT_TYPES)[number];
