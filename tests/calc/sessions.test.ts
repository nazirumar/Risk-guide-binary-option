/**
 * Phase 22 — pure-calc tests for `src/lib/news/sessions.ts`.
 *
 * Covers:
 *   - tzOffsetMinutesFor: winter vs summer DST for London + NY + Asia.
 *   - getSessionBoundaries: winter vs summer boundaries match expected UTC ranges.
 *   - classifyTradeBySession: every session + both overlaps + off-hours,
 *     in both winter (no DST) and summer (DST) — pinning DST correctness.
 *   - aggregateBySession: per-session win rate / P/L / expectancy calculation.
 *   - aggregateByHour: per-hour (in user TZ) aggregation.
 *   - bestAndWorstHours: min-trades filter + best/worst identification.
 *   - suggestTradingHours: window expansion + 6-hour cap.
 *   - hourInTz: TZ-aware hour extraction.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  tzOffsetMinutesFor,
  getSessionBoundaries,
  classifyTradeBySession,
  aggregateBySession,
  aggregateByHour,
  bestAndWorstHours,
  suggestTradingHours,
  hourInTz,
  type TradeForSession,
} from "@/lib/news/sessions";

// Helper: build a Date in UTC at a specific YYYY-MM-DD HH:MM UTC.
function utcDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // month is 1-indexed for readability.
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

// ─── tzOffsetMinutesFor ────────────────────────────────────────────────────

describe("tzOffsetMinutesFor — DST-aware TZ offset", () => {
  it("London winter (January) → 0 (GMT)", () => {
    expect(tzOffsetMinutesFor("Europe/London", utcDate(2025, 1, 15, 12))).toBe(0);
  });
  it("London summer (July) → 60 (BST)", () => {
    expect(tzOffsetMinutesFor("Europe/London", utcDate(2025, 7, 15, 12))).toBe(60);
  });
  it("New York winter (January) → -300 (EST)", () => {
    expect(tzOffsetMinutesFor("America/New_York", utcDate(2025, 1, 15, 17))).toBe(-300);
  });
  it("New York summer (July) → -240 (EDT)", () => {
    expect(tzOffsetMinutesFor("America/New_York", utcDate(2025, 7, 15, 16))).toBe(-240);
  });
  it("Tokyo year-round → 540 (JST, no DST)", () => {
    expect(tzOffsetMinutesFor("Asia/Tokyo", utcDate(2025, 1, 15, 0))).toBe(540);
    expect(tzOffsetMinutesFor("Asia/Tokyo", utcDate(2025, 7, 15, 0))).toBe(540);
  });
  it("invalid tz → 0 (UTC fallback)", () => {
    expect(tzOffsetMinutesFor("Invalid/Timezone", utcDate(2025, 1, 15, 12))).toBe(0);
  });
});

// ─── getSessionBoundaries ───────────────────────────────────────────────────

describe("getSessionBoundaries — winter vs summer UTC ranges", () => {
  it("winter (January) — Asian 00:00–09:00, London 08:00–17:00, NY 13:00–22:00", () => {
    const b = getSessionBoundaries(utcDate(2025, 1, 15, 12));
    expect(b.asian.startMin).toBe(0); // 00:00 UTC
    expect(b.asian.endMin).toBe(9 * 60); // 09:00 UTC
    expect(b.london.startMin).toBe(8 * 60); // 08:00 UTC
    expect(b.london.endMin).toBe(17 * 60); // 17:00 UTC
    expect(b.newYork.startMin).toBe(13 * 60); // 13:00 UTC
    expect(b.newYork.endMin).toBe(22 * 60); // 22:00 UTC
  });

  it("summer (July) — Asian 00:00–09:00 (unchanged), London 07:00–16:00, NY 12:00–21:00", () => {
    const b = getSessionBoundaries(utcDate(2025, 7, 15, 12));
    expect(b.asian.startMin).toBe(0);
    expect(b.asian.endMin).toBe(9 * 60);
    // London shifts forward by 1 hour in summer (BST = UTC+1).
    expect(b.london.startMin).toBe(7 * 60); // 07:00 UTC
    expect(b.london.endMin).toBe(16 * 60); // 16:00 UTC
    // NY shifts forward by 1 hour in summer (EDT = UTC-4).
    expect(b.newYork.startMin).toBe(12 * 60); // 12:00 UTC
    expect(b.newYork.endMin).toBe(21 * 60); // 21:00 UTC
  });
});

// ─── classifyTradeBySession ─────────────────────────────────────────────────

describe("classifyTradeBySession — winter (no DST)", () => {
  // January 15, 2025 — no DST in London or NY.
  it("03:00 UTC → ASIAN (Tokyo session)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 3, 0))).toBe("ASIAN");
  });
  it("10:00 UTC → LONDON (winter — London opens at 08:00 UTC)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 10, 0))).toBe("LONDON");
  });
  it("08:30 UTC → ASIAN_LONDON_OVERLAP (winter — London opened at 08:00, Tokyo still open until 09:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 8, 30))).toBe("ASIAN_LONDON_OVERLAP");
  });
  it("14:00 UTC → LONDON_NY_OVERLAP (winter — NY opens at 13:00, London until 17:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 14, 0))).toBe("LONDON_NY_OVERLAP");
  });
  it("18:00 UTC → NEW_YORK (winter — London closed at 17:00, NY until 22:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 18, 0))).toBe("NEW_YORK");
  });
  it("22:30 UTC → OFF_HOURS (winter — NY closed at 22:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 22, 30))).toBe("OFF_HOURS");
  });
  it("23:00 UTC → OFF_HOURS (between NY close + Asian open)", () => {
    expect(classifyTradeBySession(utcDate(2025, 1, 15, 23, 0))).toBe("OFF_HOURS");
  });
});

describe("classifyTradeBySession — summer (DST in London + NY)", () => {
  // July 15, 2025 — DST in both London + NY.
  it("03:00 UTC → ASIAN (Tokyo unchanged)", () => {
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 3, 0))).toBe("ASIAN");
  });
  it("07:30 UTC → ASIAN_LONDON_OVERLAP (summer — London opens at 07:00 BST = 06:00 UTC, Tokyo until 09:00)", () => {
    // Wait: London summer open is 07:00 UTC (after BST shift). Asian close is 09:00 UTC.
    // So 07:30 UTC is in the overlap window (07:00–09:00 UTC).
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 7, 30))).toBe("ASIAN_LONDON_OVERLAP");
  });
  it("10:00 UTC → LONDON (summer — London 07:00–16:00 UTC)", () => {
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 10, 0))).toBe("LONDON");
  });
  it("13:00 UTC → LONDON_NY_OVERLAP (summer — NY opens at 12:00 EDT = 12:00 UTC, London until 16:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 13, 0))).toBe("LONDON_NY_OVERLAP");
  });
  it("19:00 UTC → NEW_YORK (summer — London closed at 16:00, NY until 21:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 19, 0))).toBe("NEW_YORK");
  });
  it("21:30 UTC → OFF_HOURS (summer — NY closed at 21:00)", () => {
    expect(classifyTradeBySession(utcDate(2025, 7, 15, 21, 30))).toBe("OFF_HOURS");
  });
});

describe("classifyTradeBySession — DST transition edge cases", () => {
  it("early March (just before US DST starts) — still winter boundaries", () => {
    // US DST 2025 starts March 9. March 1 is still EST.
    expect(classifyTradeBySession(utcDate(2025, 3, 1, 14, 0))).toBe("LONDON_NY_OVERLAP");
  });
  it("late March (after US DST starts, before EU DST starts) — NY shifted, London not", () => {
    // EU DST 2025 starts March 30. March 25: NY is EDT (UTC-4), London still GMT (UTC+0).
    // London: 08:00–17:00 UTC; NY: 12:00–21:00 UTC.
    // At 14:00 UTC: London open (08:00–17:00) + NY open (12:00–21:00) → overlap.
    expect(classifyTradeBySession(utcDate(2025, 3, 25, 14, 0))).toBe("LONDON_NY_OVERLAP");
    // At 12:30 UTC: London open + NY just opened → overlap.
    expect(classifyTradeBySession(utcDate(2025, 3, 25, 12, 30))).toBe("LONDON_NY_OVERLAP");
    // At 07:00 UTC: London opens at 08:00 → not yet open. Asian ends 09:00 → ASIAN.
    expect(classifyTradeBySession(utcDate(2025, 3, 25, 7, 0))).toBe("ASIAN");
  });
});

// ─── aggregateBySession ────────────────────────────────────────────────────

describe("aggregateBySession — per-session win rate / P/L / expectancy", () => {
  function trade(
    openedAt: Date,
    profitLoss: number,
    result: "WIN" | "LOSS" | "TIE" = "WIN",
  ): TradeForSession {
    return { openedAt, profitLoss, result };
  }

  it("empty trades → 6 zero-count sessions", () => {
    const stats = aggregateBySession([]);
    expect(stats).toHaveLength(6);
    for (const s of stats) {
      expect(s.trades).toBe(0);
      expect(s.winRate).toBe(0);
      expect(s.netPL).toBe(0);
    }
  });

  it("groups trades into the correct sessions", () => {
    const trades: TradeForSession[] = [
      trade(utcDate(2025, 1, 15, 3, 0), 10), // ASIAN
      trade(utcDate(2025, 1, 15, 3, 30), -5, "LOSS"), // ASIAN
      trade(utcDate(2025, 1, 15, 10, 0), 8), // LONDON
      trade(utcDate(2025, 1, 15, 14, 0), -10, "LOSS"), // LONDON_NY_OVERLAP
    ];
    const stats = aggregateBySession(trades);
    const asian = stats.find((s) => s.session === "ASIAN")!;
    expect(asian.trades).toBe(2);
    expect(asian.wins).toBe(1);
    expect(asian.losses).toBe(1);
    expect(asian.winRate).toBe(0.5);
    expect(asian.netPL).toBe(5); // 10 + (-5)
    expect(asian.expectancyPerTrade).toBe(2.5); // 5 / 2

    const london = stats.find((s) => s.session === "LONDON")!;
    expect(london.trades).toBe(1);
    expect(london.wins).toBe(1);
    expect(london.netPL).toBe(8);
    expect(london.expectancyPerTrade).toBe(8);

    const overlap = stats.find((s) => s.session === "LONDON_NY_OVERLAP")!;
    expect(overlap.trades).toBe(1);
    expect(overlap.losses).toBe(1);
    expect(overlap.netPL).toBe(-10);
  });
});

// ─── aggregateByHour ────────────────────────────────────────────────────────

describe("aggregateByHour — per-hour aggregation in user TZ", () => {
  function trade(
    openedAt: Date,
    profitLoss: number,
    result: "WIN" | "LOSS" | "TIE" = "WIN",
  ): TradeForSession {
    return { openedAt, profitLoss, result };
  }

  it("empty → 24 zero-count hours", () => {
    const hourly = aggregateByHour([], "UTC");
    expect(hourly).toHaveLength(24);
    for (const h of hourly) {
      expect(h.trades).toBe(0);
    }
  });

  it("groups trades by hour in the user's TZ", () => {
    // 03:00 UTC → hour 3 in UTC, hour 4 in CET (UTC+1).
    const trades: TradeForSession[] = [
      trade(utcDate(2025, 1, 15, 3, 0), 10),
      trade(utcDate(2025, 1, 15, 3, 30), -5, "LOSS"),
      trade(utcDate(2025, 1, 15, 10, 0), 8),
    ];
    const utcHourly = aggregateByHour(trades, "UTC");
    expect(utcHourly[3].trades).toBe(2);
    expect(utcHourly[3].wins).toBe(1);
    expect(utcHourly[3].losses).toBe(1);
    expect(utcHourly[3].netPL).toBe(5);
    expect(utcHourly[10].trades).toBe(1);

    // In CET (UTC+1), 03:00 UTC = 04:00 CET, 10:00 UTC = 11:00 CET.
    const cetHourly = aggregateByHour(trades, "Europe/Paris");
    expect(cetHourly[4].trades).toBe(2);
    expect(cetHourly[11].trades).toBe(1);
  });

  it("win rate is 0 when trades=0", () => {
    const hourly = aggregateByHour([], "UTC");
    expect(hourly[5].winRate).toBe(0);
  });
});

// ─── bestAndWorstHours ───────────────────────────────────────────────────────

describe("bestAndWorstHours — min-trades filter + identification", () => {
  it("returns null for both when no qualifying hours (min-trades=3)", () => {
    const hourly = aggregateByHour([], "UTC");
    const r = bestAndWorstHours(hourly, 3);
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
  });

  it("returns the highest-expectancy hour as best, lowest as worst", () => {
    const trades: TradeForSession[] = [];
    // Hour 5: 3 trades, +30 net (best).
    for (let i = 0; i < 3; i++)
      trades.push({ openedAt: utcDate(2025, 1, 15, 5, i * 10), profitLoss: 10, result: "WIN" });
    // Hour 10: 3 trades, -15 net (worst).
    for (let i = 0; i < 3; i++)
      trades.push({ openedAt: utcDate(2025, 1, 15, 10, i * 10), profitLoss: -5, result: "LOSS" });
    // Hour 15: 1 trade (below min-trades threshold).
    trades.push({ openedAt: utcDate(2025, 1, 15, 15, 0), profitLoss: 100, result: "WIN" });
    const hourly = aggregateByHour(trades, "UTC");
    const r = bestAndWorstHours(hourly, 3);
    expect(r.best?.hour).toBe(5);
    expect(r.worst?.hour).toBe(10);
    expect(r.best?.expectancyPerTrade).toBe(10);
    expect(r.worst?.expectancyPerTrade).toBe(-5);
  });
});

// ─── suggestTradingHours ───────────────────────────────────────────────────

describe("suggestTradingHours — window expansion + 6-hour cap", () => {
  it("returns null when no qualifying hours", () => {
    const hourly = aggregateByHour([], "UTC");
    expect(suggestTradingHours(hourly, 3)).toBeNull();
  });

  it("suggests a window around the best hour, expanding to adjacent positive-expectancy hours", () => {
    // Build trades where hours 10-12 are profitable (3+ trades, positive expectancy).
    const trades: TradeForSession[] = [];
    for (let h = 10; h <= 12; h++) {
      for (let i = 0; i < 3; i++) {
        trades.push({ openedAt: utcDate(2025, 1, 15, h, i * 10), profitLoss: 5, result: "WIN" });
      }
    }
    // Hour 13 has 3 trades but negative expectancy → don't expand into it.
    for (let i = 0; i < 3; i++) {
      trades.push({ openedAt: utcDate(2025, 1, 15, 13, i * 10), profitLoss: -3, result: "LOSS" });
    }
    const hourly = aggregateByHour(trades, "UTC");
    const suggestion = suggestTradingHours(hourly, 3);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.start).toBe("10:00");
    expect(suggestion!.end).toBe("13:00"); // end is exclusive: 10–13 = 3 hours
    expect(suggestion!.days).toEqual([1, 2, 3, 4, 5]);
  });

  it("caps the window at 6 hours", () => {
    // 10 hours of profitable trades (would suggest a 10-hour window without cap).
    // The 6-hour cap trims symmetrically around the best hour.
    const trades: TradeForSession[] = [];
    for (let h = 5; h <= 14; h++) {
      for (let i = 0; i < 3; i++) {
        trades.push({ openedAt: utcDate(2025, 1, 15, h, i * 10), profitLoss: 5, result: "WIN" });
      }
    }
    const hourly = aggregateByHour(trades, "UTC");
    const suggestion = suggestTradingHours(hourly, 3);
    expect(suggestion).not.toBeNull();
    // All 10 hours (5..14) have equal expectancy → "best" = hour 5 (first
    // qualifying). The algorithm expands forwards through all 10 hours,
    // then trims symmetrically: trim = floor((10-6)/2) = 2, so start=5+2=7,
    // end=14-2=12. Window: [07:00, 13:00) = 6 hours.
    expect(suggestion!.start).toBe("07:00");
    expect(suggestion!.end).toBe("13:00");
  });
});

// ─── hourInTz ─────────────────────────────────────────────────────────────

describe("hourInTz — TZ-aware hour extraction", () => {
  it("UTC", () => {
    expect(hourInTz(utcDate(2025, 1, 15, 3, 0), "UTC")).toBe(3);
    expect(hourInTz(utcDate(2025, 1, 15, 23, 0), "UTC")).toBe(23);
  });
  it("Europe/Paris (UTC+1 winter, UTC+2 summer)", () => {
    // Winter CET = UTC+1: 03:00 UTC = 04:00 CET.
    expect(hourInTz(utcDate(2025, 1, 15, 3, 0), "Europe/Paris")).toBe(4);
    // Summer CEST = UTC+2: 03:00 UTC = 05:00 CEST.
    expect(hourInTz(utcDate(2025, 7, 15, 3, 0), "Europe/Paris")).toBe(5);
  });
  it("Africa/Lagos (UTC+1 year-round, no DST)", () => {
    expect(hourInTz(utcDate(2025, 1, 15, 3, 0), "Africa/Lagos")).toBe(4);
    expect(hourInTz(utcDate(2025, 7, 15, 3, 0), "Africa/Lagos")).toBe(4);
  });
  it("invalid tz → UTC fallback", () => {
    expect(hourInTz(utcDate(2025, 1, 15, 3, 0), "Invalid/Tz")).toBe(3);
  });
});
