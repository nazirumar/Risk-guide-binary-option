/**
 * Pure market-session classification helpers for Phase 22 — Sessions &
 * News.
 *
 * (PROJECT_RULES.md rule #2: all calculations live in `/src/lib/calc` or
 * `/src/lib/behavior` or `/src/lib/news` as pure, unit-tested functions.
 * Statistics use plain JS `number` since session offsets + DST adjustments
 * aren't money.)
 *
 * Forex sessions (DST-aware via `Intl.DateTimeFormat`):
 *
 *   Asian (Tokyo):     09:00–18:00 JST   → 00:00–09:00 UTC (year-round — Japan has no DST)
 *   London:            08:00–17:00 London time → winter GMT = 08:00–17:00 UTC;
 *                                             summer BST = 07:00–16:00 UTC
 *   New York:           08:00–17:00 NY time   → winter EST = 13:00–22:00 UTC;
 *                                             summer EDT = 12:00–21:00 UTC
 *
 * Overlaps (where two sessions are simultaneously open):
 *   Asian-London overlap: London open → Tokyo close (~07:00–09:00 UTC winter, ~06:00–09:00 UTC summer)
 *   London-NY overlap:     NY open → London close (~13:00–17:00 UTC winter, ~12:00–16:00 UTC summer)
 *
 * Off-hours: after NY close (~21:00/22:00 UTC) until Asian open (~00:00 UTC).
 *
 * The pure calc computes the DST-adjusted UTC boundaries for a given
 * Date, then classifies the trade's UTC time into one of:
 *   "ASIAN", "LONDON", "NEW_YORK", "ASIAN_LONDON_OVERLAP",
 *   "LONDON_NY_OVERLAP", "OFF_HOURS".
 *
 * Exports:
 *   - SESSION_DEFINITIONS (readable metadata for the UI).
 *   - tzOffsetMinutesFor(tz, d): DST-aware UTC offset for a tz at a Date.
 *   - classifyTradeBySession(utcTime): the classification.
 *   - aggregateBySession(trades): per-session win rate / P/L / expectancy.
 *   - aggregateByHour(trades, userTz): per-hour (in user TZ) win rate / P/L.
 */

// ─── Session metadata ────────────────────────────────────────────────────────

export type SessionKey =
  "ASIAN" | "LONDON" | "NEW_YORK" | "ASIAN_LONDON_OVERLAP" | "LONDON_NY_OVERLAP" | "OFF_HOURS";

export const SESSION_DEFINITIONS: Record<
  SessionKey,
  { label: string; description: string; color: string }
> = {
  ASIAN: {
    label: "Asian (Tokyo)",
    description: "Tokyo session — typically the most range-bound of the three majors.",
    color: "#8b5cf6",
  },
  LONDON: {
    label: "London",
    description: "London session — the highest-volume session, often sets the day's direction.",
    color: "#3b82f6",
  },
  NEW_YORK: {
    label: "New York",
    description: "New York session — high volatility into the NY open + US data releases.",
    color: "#10b981",
  },
  ASIAN_LONDON_OVERLAP: {
    label: "Asian–London overlap",
    description: "Brief overlap when London opens before Tokyo closes — typically quiet liquidity.",
    color: "#a855f7",
  },
  LONDON_NY_OVERLAP: {
    label: "London–NY overlap",
    description: "Peak liquidity overlap — typically the most volatile + highest-edge window.",
    color: "#f59e0b",
  },
  OFF_HOURS: {
    label: "Off-hours",
    description: "Outside the major sessions — low liquidity, wider spreads.",
    color: "#6b7280",
  },
};

// ─── DST-aware TZ offset (mirrors Phase 21 helper) ───────────────────────────

/**
 * Compute the TZ offset (in minutes) for a given IANA timezone at a specific
 * UTC instant. Uses `Intl.DateTimeFormat` to format the wall-clock time
 * in the TZ + extracts the offset from the parts. Returns 0 (UTC) for
 * invalid tz strings.
 *
 * Examples:
 *   tzOffsetMinutesFor("Europe/London", Date.UTC(2025, 0, 15, 12)) → 0 (winter GMT)
 *   tzOffsetMinutesFor("Europe/London", Date.UTC(2025, 6, 15, 12)) → 60 (summer BST)
 *   tzOffsetMinutesFor("America/New_York", Date.UTC(2025, 0, 15, 17)) → -300 (EST)
 *   tzOffsetMinutesFor("America/New_York", Date.UTC(2025, 6, 15, 16)) → -240 (EDT)
 */
export function tzOffsetMinutesFor(tz: string, d: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(d);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const y = Number(map.get("year"));
    const m = Number(map.get("month")) - 1;
    const day = Number(map.get("day"));
    const hRaw = map.get("hour");
    const h = hRaw === "24" ? 0 : Number(hRaw);
    const min = Number(map.get("minute"));
    const sec = Number(map.get("second"));
    const asUtc = Date.UTC(y, m, day, h, min, sec);
    return Math.round((asUtc - d.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

// ─── Session classification ──────────────────────────────────────────────────

/**
 * Compute the DST-adjusted UTC boundaries for each session at the given
 * UTC instant. The London + NY sessions shift by 1 hour when they enter
 * DST (London late March → late October; NY mid-March → early November).
 *
 * Boundaries returned as UTC minutes-of-day (0–1439).
 */
export function getSessionBoundaries(d: Date): {
  asian: { startMin: number; endMin: number };
  london: { startMin: number; endMin: number };
  newYork: { startMin: number; endMin: number };
} {
  // Asian (Tokyo): 09:00–18:00 JST. JST is UTC+9 year-round (no DST).
  // 09:00 JST = 00:00 UTC; 18:00 JST = 09:00 UTC.
  const asian = { startMin: 0 * 60, endMin: 9 * 60 };

  // London: 08:00–17:00 London local. Winter (GMT, +0): 08:00–17:00 UTC.
  // Summer (BST, +1): 07:00–16:00 UTC.
  const londonOffsetMin = tzOffsetMinutesFor("Europe/London", d);
  const londonStartLocalMin = 8 * 60;
  const londonEndLocalMin = 17 * 60;
  const london = {
    startMin: (londonStartLocalMin - londonOffsetMin + 24 * 60) % (24 * 60),
    endMin: (londonEndLocalMin - londonOffsetMin + 24 * 60) % (24 * 60),
  };

  // New York: 08:00–17:00 NY local. Winter (EST, -5): 13:00–22:00 UTC.
  // Summer (EDT, -4): 12:00–21:00 UTC.
  const nyOffsetMin = tzOffsetMinutesFor("America/New_York", d);
  const nyStartLocalMin = 8 * 60;
  const nyEndLocalMin = 17 * 60;
  const newYork = {
    startMin: (nyStartLocalMin - nyOffsetMin + 24 * 60) % (24 * 60),
    endMin: (nyEndLocalMin - nyOffsetMin + 24 * 60) % (24 * 60),
  };

  return { asian, london, newYork };
}

/**
 * Check whether a UTC minute-of-day is within a session's range. Handles
 * ranges that wrap past midnight (startMin > endMin → wraps to next day).
 */
function isWithinRange(utcMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) {
    return utcMin >= startMin && utcMin < endMin;
  }
  // Wrap: e.g. start=22*60, end=2*60 → range is [22:00–24:00) ∪ [00:00–02:00).
  return utcMin >= startMin || utcMin < endMin;
}

/**
 * Classify a UTC instant into one of the six session categories.
 *
 * Examples:
 *   classifyTradeBySession(Date.UTC(2025, 0, 15, 3, 0)) → "ASIAN" (03:00 UTC winter)
 *   classifyTradeBySession(Date.UTC(2025, 0, 15, 10, 0)) → "LONDON" (10:00 UTC winter)
 *   classifyTradeBySession(Date.UTC(2025, 0, 15, 14, 0)) → "LONDON_NY_OVERLAP" (14:00 UTC winter — both open)
 *   classifyTradeBySession(Date.UTC(2025, 6, 15, 13, 0)) → "LONDON_NY_OVERLAP" (13:00 UTC summer — both open with DST shift)
 *   classifyTradeBySession(Date.UTC(2025, 0, 15, 22, 30)) → "OFF_HOURS"
 */
export function classifyTradeBySession(utcTime: Date): SessionKey {
  const d = utcTime instanceof Date ? utcTime : new Date(utcTime);
  const { asian, london, newYork } = getSessionBoundaries(d);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();

  const inAsian = isWithinRange(utcMin, asian.startMin, asian.endMin);
  const inLondon = isWithinRange(utcMin, london.startMin, london.endMin);
  const inNewYork = isWithinRange(utcMin, newYork.startMin, newYork.endMin);

  if (inLondon && inNewYork) return "LONDON_NY_OVERLAP";
  if (inAsian && inLondon) return "ASIAN_LONDON_OVERLAP";
  if (inAsian) return "ASIAN";
  if (inLondon) return "LONDON";
  if (inNewYork) return "NEW_YORK";
  return "OFF_HOURS";
}

// ─── Per-session aggregation ─────────────────────────────────────────────────

export type TradeForSession = {
  /** UTC open time. */
  openedAt: Date;
  /** Signed profit/loss in account currency. */
  profitLoss: number;
  /** Trade result — WIN/LOSS/TIE (OPEN excluded by the caller). */
  result: "WIN" | "LOSS" | "TIE";
};

export type SessionStat = {
  session: SessionKey;
  label: string;
  color: string;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // 0–1
  netPL: number;
  expectancyPerTrade: number;
};

/**
 * Aggregate trades by session. Returns one row per session (including
 * sessions with 0 trades, so the UI can render the full table).
 */
export function aggregateBySession(trades: TradeForSession[]): SessionStat[] {
  // Initialize all sessions with zero counts.
  const buckets: Record<SessionKey, Omit<SessionStat, "session">> = {
    ASIAN: zeroBucket(SESSION_DEFINITIONS.ASIAN),
    LONDON: zeroBucket(SESSION_DEFINITIONS.LONDON),
    NEW_YORK: zeroBucket(SESSION_DEFINITIONS.NEW_YORK),
    ASIAN_LONDON_OVERLAP: zeroBucket(SESSION_DEFINITIONS.ASIAN_LONDON_OVERLAP),
    LONDON_NY_OVERLAP: zeroBucket(SESSION_DEFINITIONS.LONDON_NY_OVERLAP),
    OFF_HOURS: zeroBucket(SESSION_DEFINITIONS.OFF_HOURS),
  };
  for (const t of trades) {
    const session = classifyTradeBySession(t.openedAt);
    const b = buckets[session];
    b.trades++;
    b.netPL += t.profitLoss;
    if (t.result === "WIN") b.wins++;
    else if (t.result === "LOSS") b.losses++;
    else b.ties++;
  }
  return (Object.keys(buckets) as SessionKey[]).map((k) => {
    const b = buckets[k];
    const winRate = b.trades > 0 ? b.wins / b.trades : 0;
    const expectancy = b.trades > 0 ? b.netPL / b.trades : 0;
    return {
      session: k,
      label: b.label,
      color: b.color,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      ties: b.ties,
      winRate,
      netPL: Math.round(b.netPL * 100) / 100,
      expectancyPerTrade: Math.round(expectancy * 100) / 100,
    };
  });
}

function zeroBucket(def: { label: string; color: string }): Omit<SessionStat, "session"> {
  return {
    label: def.label,
    color: def.color,
    trades: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    winRate: 0,
    netPL: 0,
    expectancyPerTrade: 0,
  };
}

// ─── Per-hour aggregation (in user TZ) ───────────────────────────────────────

export type HourStat = {
  /** Hour of day 0–23 (in the user's TZ). */
  hour: number;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // 0–1
  netPL: number;
  expectancyPerTrade: number;
};

/**
 * Aggregate trades by hour-of-day in the user's TZ. Returns 24 rows (one
 * per hour, including 0-trade hours).
 */
export function aggregateByHour(trades: TradeForSession[], userTz: string): HourStat[] {
  const buckets: HourStat[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    trades: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    winRate: 0,
    netPL: 0,
    expectancyPerTrade: 0,
  }));
  for (const t of trades) {
    const hour = hourInTz(t.openedAt, userTz);
    const b = buckets[hour];
    b.trades++;
    b.netPL += t.profitLoss;
    if (t.result === "WIN") b.wins++;
    else if (t.result === "LOSS") b.losses++;
    else b.ties++;
  }
  for (const b of buckets) {
    b.winRate = b.trades > 0 ? b.wins / b.trades : 0;
    b.netPL = Math.round(b.netPL * 100) / 100;
    b.expectancyPerTrade = b.trades > 0 ? Math.round((b.netPL / b.trades) * 100) / 100 : 0;
  }
  return buckets;
}

/**
 * Compute the hour-of-day (0–23) of a Date in the given IANA timezone.
 * Falls back to UTC hour on invalid tz.
 */
export function hourInTz(d: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    if (hourPart == null) return d.getUTCHours();
    // "24" can appear in some ICU versions for midnight; treat as 0.
    return hourPart === "24" ? 0 : Number(hourPart);
  } catch {
    return d.getUTCHours();
  }
}

// ─── Best/worst hour suggestion ──────────────────────────────────────────────

/**
 * Compute the best + worst trading hours (by expectancy, requires ≥3 trades
 * to qualify — otherwise the stat is too noisy).
 *
 * Returns null when no qualifying hours exist.
 */
export function bestAndWorstHours(
  hourly: HourStat[],
  minTrades = 3,
): { best: HourStat | null; worst: HourStat | null } {
  const qualifying = hourly.filter((h) => h.trades >= minTrades);
  if (qualifying.length === 0) return { best: null, worst: null };
  const best = qualifying.reduce((acc, h) =>
    h.expectancyPerTrade > acc.expectancyPerTrade ? h : acc,
  );
  const worst = qualifying.reduce((acc, h) =>
    h.expectancyPerTrade < acc.expectancyPerTrade ? h : acc,
  );
  return { best, worst };
}

/**
 * Suggest trading hours based on the best-performing hour range. Returns
 * a { start: "HH:MM", end: "HH:MM", days: [1..5] } suggestion suitable for
 * the Phase 12 trading-hours setting, or null when no qualifying hours
 * exist.
 *
 * Strategy: find the hour with the highest expectancy (≥3 trades), then
 * expand the window to include adjacent hours whose expectancy is also
 * positive. Cap the window at 6 hours.
 */
export function suggestTradingHours(
  hourly: HourStat[],
  minTrades = 3,
): { start: string; end: string; days: number[] } | null {
  const { best } = bestAndWorstHours(hourly, minTrades);
  if (!best) return null;

  // Expand from the best hour outward — include adjacent hours with
  // positive expectancy (and ≥3 trades).
  let start = best.hour;
  let end = best.hour;
  // Expand backwards (earlier hours).
  for (let h = best.hour - 1; h >= 0; h--) {
    const bucket = hourly[h];
    if (bucket.trades < minTrades || bucket.expectancyPerTrade <= 0) break;
    start = h;
  }
  // Expand forwards (later hours).
  for (let h = best.hour + 1; h < 24; h++) {
    const bucket = hourly[h];
    if (bucket.trades < minTrades || bucket.expectancyPerTrade <= 0) break;
    end = h;
  }
  // Cap the window at 6 hours (don't suggest a marathon session).
  const windowSize = end - start + 1;
  if (windowSize > 6) {
    // Trim symmetrically around the best hour.
    const trim = Math.floor((windowSize - 6) / 2);
    start += trim;
    end -= windowSize - 6 - trim;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  // The end is inclusive in the suggestion: if end=15, the window closes
  // at 16:00 (start of the 16:00 hour).
  return {
    start: `${pad(start)}:00`,
    end: `${pad((end + 1) % 24)}:00`,
    days: [1, 2, 3, 4, 5], // Mon–Fri by default
  };
}
