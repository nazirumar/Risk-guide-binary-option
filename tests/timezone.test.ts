/**
 * Phase 7 — unit tests for the pure timezone helpers in
 * `src/lib/timezone.ts`. Doesn't touch the DB; uses fixed UTC instants
 * so the assertions are stable across runs.
 */
import { describe, it, expect } from "vitest";
import {
  startOfTodayUtc,
  startOfWeekUtc,
  isSameDayTz,
  isSameWeekTz,
  nextMidnightUtc,
  nextWeekStartUtc,
} from "@/lib/timezone";

describe("startOfTodayUtc — UTC timezone", () => {
  it("returns UTC midnight for a UTC-timezone user at noon UTC", () => {
    // 2026-10-26 12:00 UTC
    const ref = new Date("2026-10-26T12:00:00Z");
    const start = startOfTodayUtc("UTC", ref);
    expect(start.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("returns UTC midnight for a UTC-timezone user at 23:00 UTC", () => {
    const ref = new Date("2026-10-26T23:00:00Z");
    const start = startOfTodayUtc("UTC", ref);
    expect(start.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("rolls over at UTC midnight", () => {
    // 2026-10-26 00:00 UTC = first instant of new UTC day
    const ref = new Date("2026-10-26T00:00:00Z");
    const start = startOfTodayUtc("UTC", ref);
    expect(start.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("startOfTodayUtc — Africa/Lagos (UTC+1, no DST)", () => {
  it("returns 23:00 previous-UTC-day for a Lagos user at noon Lagos", () => {
    // 2026-10-26 12:00 Lagos = 2026-10-26 11:00 UTC
    // Lagos midnight on 2026-10-26 = 2026-10-25 23:00 UTC
    const ref = new Date("2026-10-26T11:00:00Z");
    const start = startOfTodayUtc("Africa/Lagos", ref);
    expect(start.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("rolls over at Lagos midnight (UTC 23:00)", () => {
    // 2026-10-26 23:00 UTC = 2026-10-27 00:00 Lagos — NEW DAY in Lagos
    const ref = new Date("2026-10-26T23:00:00Z");
    const start = startOfTodayUtc("Africa/Lagos", ref);
    expect(start.toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });

  it("just BEFORE Lagos midnight is still yesterday's Lagos day", () => {
    // 2026-10-26 22:59:59 UTC = 2026-10-26 23:59:59 Lagos — still 2026-10-26 in Lagos
    const ref = new Date("2026-10-26T22:59:59Z");
    const start = startOfTodayUtc("Africa/Lagos", ref);
    // Lagos day 2026-10-26 started at 2026-10-25 23:00 UTC
    expect(start.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("startOfTodayUtc — America/New_York (UTC-4 in DST, UTC-5 in standard)", () => {
  it("returns 04:00 UTC for a NY user at noon NY (EDT, UTC-4)", () => {
    // 2026-10-26 12:00 NY (EDT) = 2026-10-26 16:00 UTC
    // NY midnight on 2026-10-26 EDT = 2026-10-26 04:00 UTC
    const ref = new Date("2026-10-26T16:00:00Z");
    const start = startOfTodayUtc("America/New_York", ref);
    expect(start.toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("returns 05:00 UTC for a NY user at noon NY (EST, UTC-5) in winter", () => {
    // 2026-01-15 12:00 NY (EST) = 2026-01-15 17:00 UTC
    // NY midnight on 2026-01-15 EST = 2026-01-15 05:00 UTC
    const ref = new Date("2026-01-15T17:00:00Z");
    const start = startOfTodayUtc("America/New_York", ref);
    expect(start.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});

describe("startOfTodayUtc — extreme TZs", () => {
  it("Pacific/Kiritimati (UTC+14) — 14h ahead of UTC", () => {
    // 2026-10-26 10:00 Kiritimati = 2026-10-25 20:00 UTC
    // Kiritimati midnight on 2026-10-26 = 2026-10-25 10:00 UTC
    const ref = new Date("2026-10-25T20:00:00Z");
    const start = startOfTodayUtc("Pacific/Kiritimati", ref);
    expect(start.toISOString()).toBe("2026-10-25T10:00:00.000Z");
  });

  it("Pacific/Honolulu (UTC-10) — 10h behind UTC", () => {
    // 2026-10-26 10:00 Honolulu = 2026-10-26 20:00 UTC
    // Honolulu midnight on 2026-10-26 = 2026-10-26 10:00 UTC
    const ref = new Date("2026-10-26T20:00:00Z");
    const start = startOfTodayUtc("Pacific/Honolulu", ref);
    expect(start.toISOString()).toBe("2026-10-26T10:00:00.000Z");
  });
});

describe("startOfWeekUtc", () => {
  it("returns Sunday midnight UTC for a UTC user mid-week", () => {
    // 2026-10-28 is a Wednesday; Sunday was 2026-10-25
    const ref = new Date("2026-10-28T12:00:00Z");
    const start = startOfWeekUtc("UTC", ref);
    expect(start.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  it("returns the same Sunday when ref is Sunday itself", () => {
    // 2026-10-25 is a Sunday
    const ref = new Date("2026-10-25T12:00:00Z");
    const start = startOfWeekUtc("UTC", ref);
    expect(start.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  it("respects user TZ — Lagos Sunday midnight = Saturday 23:00 UTC", () => {
    // 2026-10-26 is Monday in UTC; Sunday was 2026-10-25.
    // For Lagos (UTC+1), Sunday 2026-10-25 00:00 Lagos = 2026-10-24 23:00 UTC.
    const ref = new Date("2026-10-26T11:00:00Z"); // Monday noon Lagos
    const start = startOfWeekUtc("Africa/Lagos", ref);
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });
});

describe("isSameDayTz", () => {
  it("same UTC instant → same day in any TZ", () => {
    const d = new Date("2026-10-26T12:00:00Z");
    expect(isSameDayTz(d, d, "UTC")).toBe(true);
    expect(isSameDayTz(d, d, "Africa/Lagos")).toBe(true);
  });
  it("23:59 UTC and 00:01 UTC next day → DIFFERENT day in UTC TZ", () => {
    const d1 = new Date("2026-10-26T23:59:00Z");
    const d2 = new Date("2026-10-27T00:01:00Z");
    expect(isSameDayTz(d1, d2, "UTC")).toBe(false);
  });
  it("23:59 UTC and 00:01 UTC next day → SAME day in Lagos (UTC+1)", () => {
    // 2026-10-26 23:59 UTC = 2026-10-27 00:59 Lagos
    // 2026-10-27 00:01 UTC = 2026-10-27 01:01 Lagos
    // Both are 2026-10-27 in Lagos.
    const d1 = new Date("2026-10-26T23:59:00Z");
    const d2 = new Date("2026-10-27T00:01:00Z");
    expect(isSameDayTz(d1, d2, "Africa/Lagos")).toBe(true);
  });
  it("22:59 UTC and 23:01 UTC → DIFFERENT day in Lagos (UTC+1)", () => {
    // 2026-10-26 22:59 UTC = 2026-10-26 23:59 Lagos
    // 2026-10-26 23:01 UTC = 2026-10-27 00:01 Lagos — new day in Lagos
    const d1 = new Date("2026-10-26T22:59:00Z");
    const d2 = new Date("2026-10-26T23:01:00Z");
    expect(isSameDayTz(d1, d2, "Africa/Lagos")).toBe(false);
  });
});

describe("isSameWeekTz", () => {
  it("same Sunday-start week in UTC TZ", () => {
    // Wednesday 2026-10-28 and Friday 2026-10-30 → same week (Sunday 2026-10-25)
    const d1 = new Date("2026-10-28T12:00:00Z");
    const d2 = new Date("2026-10-30T12:00:00Z");
    expect(isSameWeekTz(d1, d2, "UTC")).toBe(true);
  });
  it("different weeks when crossing Sunday", () => {
    // Saturday 2026-10-31 and Sunday 2026-11-01 → different weeks in UTC
    const d1 = new Date("2026-10-31T12:00:00Z");
    const d2 = new Date("2026-11-01T12:00:00Z");
    expect(isSameWeekTz(d1, d2, "UTC")).toBe(false);
  });
});

describe("nextMidnightUtc", () => {
  it("returns next UTC midnight for a UTC user", () => {
    const ref = new Date("2026-10-26T12:00:00Z");
    const next = nextMidnightUtc("UTC", ref);
    expect(next.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });
  it("returns next Lagos midnight (UTC 23:00) for a Lagos user at noon", () => {
    const ref = new Date("2026-10-26T11:00:00Z"); // noon Lagos
    const next = nextMidnightUtc("Africa/Lagos", ref);
    expect(next.toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });
});

describe("nextWeekStartUtc", () => {
  it("returns next Sunday midnight UTC for a UTC user", () => {
    // Wednesday 2026-10-28 → next Sunday is 2026-11-01
    const ref = new Date("2026-10-28T12:00:00Z");
    const next = nextWeekStartUtc("UTC", ref);
    expect(next.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
