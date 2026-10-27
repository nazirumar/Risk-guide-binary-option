/**
 * Timezone helpers (PROJECT_RULES.md Phase 7 spec: "Use the user's timezone
 * to define 'today' and 'this week'").
 *
 * All functions take the user's IANA timezone string (e.g. "Africa/Lagos",
 * "America/New_York", "UTC") and return UTC Date objects for the start of
 * the relevant period.
 *
 * Pure — no DB access, no side effects. Tested via tests/timezone.test.ts.
 *
 * Algorithm: use Intl.DateTimeFormat to get the local-time components at
 * a given UTC instant, derive the offset (which includes DST), then compute
 * the UTC instant of local-midnight.
 */

/**
 * Returns the offset in milliseconds between the user's TZ and UTC at the
 * given reference date. Positive for TZs east of UTC (e.g., Lagos +1h =
 * +3600000ms if we use the convention "local = UTC + offset"). But our
 * sign is INVERTED here (see implementation) — see the worked example in
 * tests/timezone.test.ts.
 *
 * Actually let me clarify: this function returns the offset such that
 *   localMs = utcMs + offset
 * For Lagos (UTC+1), local is 1h ahead → offset = +3600000ms.
 * For LA (UTC-7), local is 7h behind → offset = -25200000ms.
 */
function getOffsetMs(timezone: string, refDate: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(refDate);
  const get = (type: string) => {
    const v = parts.find((p) => p.type === type)?.value ?? "0";
    // The "hour" can come back as "24" for midnight in some locales
    // using hour12: false; normalize to "00".
    if (type === "hour" && v === "24") return "00";
    return v;
  };
  const localY = Number(get("year"));
  const localM = Number(get("month")) - 1; // JS months are 0-indexed
  const localD = Number(get("day"));
  const localH = Number(get("hour"));
  const localMin = Number(get("minute"));
  const localS = Number(get("second"));

  // The UTC instant if those local components were treated as UTC.
  const localAsUtc = Date.UTC(localY, localM, localD, localH, localMin, localS);
  // offset = local - UTC = refDate - localAsUtc (NEGATED, because localAsUtc
  // is "the UTC instant that has the same wall-clock digits as local" — and
  // if local is 1h ahead of UTC, localAsUtc is 1h ahead of refDate).
  // So: localReal = utcReal + offset → offset = localReal - utcReal = localAsUtc - refDate.
  return localAsUtc - refDate.getTime();
}

/**
 * Returns the UTC Date of local-midnight on the date that `refDate` falls
 * into in the user's TZ.
 *
 * Example: user in Africa/Lagos (UTC+1). refDate = 2026-10-26 14:00 UTC
 * (= 2026-10-26 15:00 Lagos). Local date = 2026-10-26. Lagos midnight on
 * 2026-10-26 = 2026-10-25 23:00 UTC.
 */
export function startOfTodayUtc(timezone: string, refDate: Date = new Date()): Date {
  const offsetMs = getOffsetMs(timezone, refDate);
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(refDate);
  const get = (type: string) => Number(localParts.find((p) => p.type === type)?.value ?? "0");
  const localY = get("year");
  const localM = get("month") - 1;
  const localD = get("day");
  // UTC instant if local-midnight components were treated as UTC:
  const localMidnightAsUtc = Date.UTC(localY, localM, localD, 0, 0, 0);
  // Real UTC instant = localMidnightAsUtc - offset (because offset is how
  // much to ADD to UTC to get local; to convert local → UTC, we subtract).
  return new Date(localMidnightAsUtc - offsetMs);
}

/**
 * Returns the UTC Date of local-midnight on the Sunday starting the week
 * that `refDate` falls into in the user's TZ. Week starts Sunday (US
 * convention; matches how most trading platforms roll weekly bars).
 *
 * Example: refDate = 2026-10-26 (Monday). Sunday of that week = 2026-10-25.
 */
export function startOfWeekUtc(timezone: string, refDate: Date = new Date()): Date {
  // First find the local Y/M/D in user's TZ.
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(refDate);
  const get = (type: string) => localParts.find((p) => p.type === type)?.value ?? "0";
  const localY = Number(get("year"));
  const localM = Number(get("month")) - 1;
  const localD = Number(get("day"));
  const weekday = get("weekday"); // "Sun", "Mon", etc.

  // Map weekday short-name to 0..6 (Sun=0).
  const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = WEEKDAY_MAP[weekday] ?? 0;

  // Compute Sunday's local Y/M/D by subtracting `dow` days from local today.
  // We do this on a Date constructed as UTC midnight for the local Y/M/D,
  // then subtract dow days, then reconvert to UTC via the offset.
  const offsetMs = getOffsetMs(timezone, refDate);
  const localTodayMidnightAsUtc = Date.UTC(localY, localM, localD, 0, 0, 0);
  const sundayLocalMidnightAsUtc = localTodayMidnightAsUtc - dow * 24 * 3600 * 1000;
  // Re-derive offset at the Sunday midnight instant (DST may have changed).
  const sundayRef = new Date(sundayLocalMidnightAsUtc - offsetMs);
  const sundayOffsetMs = getOffsetMs(timezone, sundayRef);
  // Final UTC instant of Sunday local-midnight:
  return new Date(sundayLocalMidnightAsUtc - sundayOffsetMs);
}

/**
 * Returns true if the two dates fall on the same calendar day in the
 * user's TZ. Used to filter "today" trades in JS without exact UTC
 * window computation.
 */
export function isSameDayTz(d1: Date, d2: Date, timezone: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d1) === fmt.format(d2);
}

/**
 * Returns true if the two dates fall in the same calendar week (Sun-Sat)
 * in the user's TZ.
 */
export function isSameWeekTz(d1: Date, d2: Date, timezone: string): boolean {
  // Find Sunday-of-week for each date, compare date strings.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts1 = fmt.formatToParts(d1);
  const parts2 = fmt.formatToParts(d2);
  const get = (parts: Array<{ type: string; value: string }>, type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const y1 = Number(get(parts1, "year"));
  const m1 = Number(get(parts1, "month")) - 1;
  const d1Local = Number(get(parts1, "day"));
  const wd1 = get(parts1, "weekday");
  const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow1 = WEEKDAY_MAP[wd1] ?? 0;
  const sunday1 = new Date(Date.UTC(y1, m1, d1Local) - dow1 * 24 * 3600 * 1000);

  const y2 = Number(get(parts2, "year"));
  const m2 = Number(get(parts2, "month")) - 1;
  const d2Local = Number(get(parts2, "day"));
  const wd2 = get(parts2, "weekday");
  const dow2 = WEEKDAY_MAP[wd2] ?? 0;
  const sunday2 = new Date(Date.UTC(y2, m2, d2Local) - dow2 * 24 * 3600 * 1000);

  return sunday1.getTime() === sunday2.getTime();
}

/**
 * Returns the UTC Date when the user's "next midnight" occurs after `refDate`.
 * Used for lockout expiry (DAILY_LOSS lockouts expire at next user-midnight).
 */
export function nextMidnightUtc(timezone: string, refDate: Date = new Date()): Date {
  const start = startOfTodayUtc(timezone, refDate);
  return new Date(start.getTime() + 24 * 3600 * 1000);
}

/**
 * Returns the UTC Date of the user's next Sunday midnight (start of next
 * week). Used for WEEKLY_LOSS lockout expiry.
 */
export function nextWeekStartUtc(timezone: string, refDate: Date = new Date()): Date {
  const start = startOfWeekUtc(timezone, refDate);
  return new Date(start.getTime() + 7 * 24 * 3600 * 1000);
}
