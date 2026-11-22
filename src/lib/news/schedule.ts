/**
 * Pure scheduling helpers for the optional news briefing (Phase 30 follow-on).
 *
 * No Next.js, Prisma or provider imports. Times are "HH:MM" in the user's own
 * timezone; the CRON sweep calls `isBriefingDue` for every opted-in user. The
 * 15-minute window matches the recommended cron cadence and tolerates a late
 * runner without sending twice (the sweep also records a per-user audit row).
 */
export const BRIEFING_FREQUENCIES = ["DAILY", "WEEKDAYS", "WEEKLY"] as const;
export type BriefingFrequency = (typeof BRIEFING_FREQUENCIES)[number];

export const DEFAULT_BRIEFING_TIME = "08:00";
export const DEFAULT_BRIEFING_FREQUENCY: BriefingFrequency = "DAILY";
export const DEFAULT_BRIEFING_WEEKDAY = 1;

export type BriefingSchedule = {
  briefingTime: string;
  briefingFrequency: BriefingFrequency;
  /** 0 = Sunday … 6 = Saturday; only used for WEEKLY. */
  briefingWeekday: number;
};

export function normalizeBriefingTime(value: unknown): string | null {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

export function normalizeBriefingFrequency(value: unknown): BriefingFrequency | null {
  return BRIEFING_FREQUENCIES.includes(value as BriefingFrequency)
    ? (value as BriefingFrequency)
    : null;
}

export function normalizeBriefingWeekday(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

/** Validate/normalize a stored (or submitted) briefing schedule. */
export function normalizeBriefingSchedule(
  value:
    | {
        briefingTime?: unknown;
        briefingFrequency?: unknown;
        briefingWeekday?: unknown;
      }
    | null
    | undefined,
): BriefingSchedule {
  return {
    briefingTime: normalizeBriefingTime(value?.briefingTime) ?? DEFAULT_BRIEFING_TIME,
    briefingFrequency:
      normalizeBriefingFrequency(value?.briefingFrequency) ?? DEFAULT_BRIEFING_FREQUENCY,
    briefingWeekday: normalizeBriefingWeekday(value?.briefingWeekday) ?? DEFAULT_BRIEFING_WEEKDAY,
  };
}

export type LocalClock = {
  /** "YYYY-MM-DD" in the user's timezone. */
  dateKey: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Intl-based clock read; invalid timezones fall back to UTC. */
export function localClockInTz(now: Date, timezone: string | null | undefined): LocalClock {
  const tz = timezone || "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  }
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = Math.max(0, WEEKDAYS.indexOf(part("weekday")));
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  const dateKey = `${part("year")}-${part("month")}-${part("day")}`;
  return { dateKey, weekday, minutes };
}

/**
 * True only in the bucket starting at the user's chosen time. DAILY fires
 * every day, WEEKDAYS only Mon–Fri, WEEKLY only on the chosen weekday.
 */
export function isBriefingDue(
  schedule: Parameters<typeof normalizeBriefingSchedule>[0],
  now: Date,
  timezone: string | null | undefined,
  bucketMinutes = 15,
): boolean {
  const { briefingTime, briefingFrequency, briefingWeekday } = normalizeBriefingSchedule(schedule);
  const clock = localClockInTz(now, timezone);
  if (briefingFrequency === "WEEKDAYS" && (clock.weekday === 0 || clock.weekday === 6)) {
    return false;
  }
  if (briefingFrequency === "WEEKLY" && clock.weekday !== briefingWeekday) return false;
  const [hh, mm] = briefingTime.split(":").map(Number);
  const target = hh * 60 + mm;
  const width = Number.isFinite(bucketMinutes) && bucketMinutes > 0 ? bucketMinutes : 15;
  return clock.minutes >= target && clock.minutes < target + width;
}
