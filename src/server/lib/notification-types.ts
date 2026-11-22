/**
 * Notification types + constants — kept outside the "use server" file because
 * Next.js 16's Turbopack requires "use server" files to export ONLY async
 * functions. Type exports and const exports are flagged as "found object".
 */

import {
  DEFAULT_BRIEFING_FREQUENCY,
  DEFAULT_BRIEFING_TIME,
  DEFAULT_BRIEFING_WEEKDAY,
  type BriefingFrequency,
} from "@/lib/news/schedule";

export type { BriefingFrequency, BriefingSchedule } from "@/lib/news/schedule";
export {
  BRIEFING_FREQUENCIES,
  DEFAULT_BRIEFING_FREQUENCY,
  DEFAULT_BRIEFING_TIME,
  DEFAULT_BRIEFING_WEEKDAY,
} from "@/lib/news/schedule";

export type NotificationPreference = {
  inApp: boolean;
  email: boolean;
  telegram?: boolean;
  /** Optional per-user timing for NEWS_BRIEFING (HH:MM in the user's TZ). */
  briefingTime?: string;
  briefingFrequency?: BriefingFrequency;
  briefingWeekday?: number;
};

export type NotificationPrefs = Record<string, NotificationPreference>;

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
  TRADE_ADDED: { inApp: false, email: false, telegram: true },
  // Phase 30.4 — scheduled news briefing. OFF on every channel by default;
  // the user must opt in explicitly in Settings (in-app/email/Telegram).
  NEWS_BRIEFING: {
    inApp: false,
    email: false,
    telegram: false,
    briefingTime: DEFAULT_BRIEFING_TIME,
    briefingFrequency: DEFAULT_BRIEFING_FREQUENCY,
    briefingWeekday: DEFAULT_BRIEFING_WEEKDAY,
  },
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
  "TRADE_ADDED",
  "NEWS_BRIEFING",
] as const;

export type TelegramAlertType = (typeof TELEGRAM_ALERT_TYPES)[number];
