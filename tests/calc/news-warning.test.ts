/**
 * Phase 22 — pure-calc tests for `src/lib/news/warning.ts`.
 *
 * Covers:
 *   - getCurrenciesFromAsset: slash-separated, concatenated, non-forex,
 *     empty, lowercase, with-spaces.
 *   - isIso4217Currency: known codes, unknown codes.
 *   - isEventRelevantForCurrencies: direct match, mismatch, global "*".
 *   - isWithinWarningWindow: before, at, after, boundary inclusive/
 *     exclusive.
 *   - findRelevantHighImpactEvents: the main entry — relevant currencies,
 *     impact filter, window filter, sort by distance.
 */
import { describe, it, expect } from "vitest";
import {
  getCurrenciesFromAsset,
  isIso4217Currency,
  isEventRelevantForCurrencies,
  isWithinWarningWindow,
  findRelevantHighImpactEvents,
} from "@/lib/news/warning";

// ─── getCurrenciesFromAsset ───────────────────────────────────────────────────

describe("getCurrenciesFromAsset — currency extraction from forex pairs", () => {
  it("slash-separated standard pair → [base, quote]", () => {
    expect(getCurrenciesFromAsset("EUR/USD")).toEqual(["EUR", "USD"]);
    expect(getCurrenciesFromAsset("GBP/JPY")).toEqual(["GBP", "JPY"]);
    expect(getCurrenciesFromAsset("AUD/CAD")).toEqual(["AUD", "CAD"]);
  });

  it("lowercase input is normalized to uppercase", () => {
    expect(getCurrenciesFromAsset("eur/usd")).toEqual(["EUR", "USD"]);
    expect(getCurrenciesFromAsset("gbpjpy")).toEqual(["GBP", "JPY"]);
  });

  it("whitespace is trimmed", () => {
    expect(getCurrenciesFromAsset("  EUR/USD  ")).toEqual(["EUR", "USD"]);
  });

  it("concatenated 6-char pair with both known currencies → [base, quote]", () => {
    expect(getCurrenciesFromAsset("EURUSD")).toEqual(["EUR", "USD"]);
    expect(getCurrenciesFromAsset("GBPJPY")).toEqual(["GBP", "JPY"]);
  });

  it("non-forex asset (e.g. BTC/USD) → ['*'] (global, so global news still warns)", () => {
    expect(getCurrenciesFromAsset("BTC/USD")).toEqual(["*"]);
    expect(getCurrenciesFromAsset("ETH/USD")).toEqual(["*"]);
  });

  it("single-token asset (e.g. GOLD, BTC) → ['*']", () => {
    expect(getCurrenciesFromAsset("GOLD")).toEqual(["*"]);
    expect(getCurrenciesFromAsset("BTC")).toEqual(["*"]);
    expect(getCurrenciesFromAsset("SILVER")).toEqual(["*"]);
  });

  it("empty string → ['*']", () => {
    expect(getCurrenciesFromAsset("")).toEqual(["*"]);
    expect(getCurrenciesFromAsset("   ")).toEqual(["*"]);
  });

  it("concatenated 6-char but one side is non-currency → ['*']", () => {
    expect(getCurrenciesFromAsset("BTCUSD")).toEqual(["*"]); // BTC isn't ISO 4217
  });
});

// ─── isIso4217Currency ─────────────────────────────────────────────────────────

describe("isIso4217Currency — ISO 4217 check", () => {
  it("major currencies return true", () => {
    expect(isIso4217Currency("USD")).toBe(true);
    expect(isIso4217Currency("EUR")).toBe(true);
    expect(isIso4217Currency("GBP")).toBe(true);
    expect(isIso4217Currency("JPY")).toBe(true);
    expect(isIso4217Currency("AUD")).toBe(true);
    expect(isIso4217Currency("CAD")).toBe(true);
    expect(isIso4217Currency("CHF")).toBe(true);
    expect(isIso4217Currency("NZD")).toBe(true);
  });

  it("minor currencies return true", () => {
    expect(isIso4217Currency("SEK")).toBe(true);
    expect(isIso4217Currency("MXN")).toBe(true);
    expect(isIso4217Currency("ZAR")).toBe(true);
    expect(isIso4217Currency("SGD")).toBe(true);
  });

  it("non-ISO codes return false", () => {
    expect(isIso4217Currency("BTC")).toBe(false);
    expect(isIso4217Currency("ETH")).toBe(false);
    expect(isIso4217Currency("XYZ")).toBe(false);
    expect(isIso4217Currency("")).toBe(false);
  });

  it("lowercase input is normalized to uppercase", () => {
    expect(isIso4217Currency("usd")).toBe(true);
    expect(isIso4217Currency("eur")).toBe(true);
  });
});

// ─── isEventRelevantForCurrencies ─────────────────────────────────────────────

describe("isEventRelevantForCurrencies — relevance check", () => {
  it("direct currency match → true", () => {
    expect(isEventRelevantForCurrencies({ currency: "USD" }, ["EUR", "USD"])).toBe(true);
    expect(isEventRelevantForCurrencies({ currency: "EUR" }, ["EUR", "USD"])).toBe(true);
  });

  it("no currency match → false", () => {
    expect(isEventRelevantForCurrencies({ currency: "GBP" }, ["EUR", "USD"])).toBe(false);
    expect(isEventRelevantForCurrencies({ currency: "JPY" }, ["EUR", "USD"])).toBe(false);
  });

  it("global '*' event → true regardless of currencies", () => {
    expect(isEventRelevantForCurrencies({ currency: "*" }, ["EUR", "USD"])).toBe(true);
    expect(isEventRelevantForCurrencies({ currency: "*" }, ["GBP", "JPY"])).toBe(true);
    expect(isEventRelevantForCurrencies({ currency: "*" }, ["*"])).toBe(true);
  });

  it("case-insensitive comparison", () => {
    expect(isEventRelevantForCurrencies({ currency: "usd" }, ["eur", "usd"])).toBe(true);
    expect(isEventRelevantForCurrencies({ currency: "USD" }, ["eur", "usd"])).toBe(true);
  });
});

// ─── isWithinWarningWindow ─────────────────────────────────────────────────────

describe("isWithinWarningWindow — boundary check", () => {
  // Event at 14:00 UTC. Window = 15 min.
  const eventTime = new Date(Date.UTC(2025, 0, 15, 14, 0));

  it("5 minutes before → true", () => {
    const trade = new Date(Date.UTC(2025, 0, 15, 13, 55));
    expect(isWithinWarningWindow(trade, eventTime, 15)).toBe(true);
  });

  it("exactly at event → true", () => {
    expect(isWithinWarningWindow(eventTime, eventTime, 15)).toBe(true);
  });

  it("14 minutes after → true", () => {
    const trade = new Date(Date.UTC(2025, 0, 15, 14, 14));
    expect(isWithinWarningWindow(trade, eventTime, 15)).toBe(true);
  });

  it("15 minutes after → false (boundary exclusive)", () => {
    const trade = new Date(Date.UTC(2025, 0, 15, 14, 15));
    expect(isWithinWarningWindow(trade, eventTime, 15)).toBe(false);
  });

  it("15 minutes before → false (boundary exclusive)", () => {
    const trade = new Date(Date.UTC(2025, 0, 15, 13, 45));
    expect(isWithinWarningWindow(trade, eventTime, 15)).toBe(false);
  });

  it("1 hour before → false", () => {
    const trade = new Date(Date.UTC(2025, 0, 15, 13, 0));
    expect(isWithinWarningWindow(trade, eventTime, 15)).toBe(false);
  });

  it("zero-minute window → only matches within 0 ms (effectively no events, since the window is strict-less-than)", () => {
    // A 0-minute window is degenerate — diffMs < 0 is always false (diffMs
    // is non-negative). So no trade ever fires the warning under a 0-min
    // window. This is the spec'd "disable the warning" case (when the user
    // sets minutes=0, the warning effectively never fires — equivalent to
    // turning it off via newsWarningEnabled=false).
    expect(isWithinWarningWindow(eventTime, eventTime, 0)).toBe(false);
    const oneMinBefore = new Date(eventTime.getTime() - 60_000);
    expect(isWithinWarningWindow(oneMinBefore, eventTime, 0)).toBe(false);
  });
});

// ─── findRelevantHighImpactEvents ─────────────────────────────────────────────

describe("findRelevantHighImpactEvents — main entry", () => {
  const tradeTime = new Date(Date.UTC(2025, 0, 15, 14, 0));

  const events = [
    {
      currency: "USD",
      title: "US NFP",
      impact: "HIGH",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 14, 5)),
    },
    {
      currency: "EUR",
      title: "ECB Rate Decision",
      impact: "HIGH",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 13, 50)),
    },
    {
      currency: "GBP",
      title: "BoE Minutes",
      impact: "HIGH",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 14, 10)),
    },
    {
      currency: "*",
      title: "Global Risk Event",
      impact: "HIGH",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 14, 0)),
    },
    {
      currency: "USD",
      title: "US Trade Balance",
      impact: "MEDIUM",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 14, 0)),
    },
    {
      currency: "USD",
      title: "US CPI (out of window)",
      impact: "HIGH",
      scheduledAt: new Date(Date.UTC(2025, 0, 15, 15, 0)),
    },
  ];

  it("returns matching HIGH-impact events for EUR/USD within 15-min window", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 15,
    });
    // Expected: USD NFP (5 min after), ECB Rate Decision (10 min before),
    // Global Risk Event (exactly at trade time). NOT BoE Minutes (GBP doesn't
    // match EUR/USD), NOT US Trade Balance (MEDIUM not HIGH), NOT US CPI
    // (60 min after — out of window).
    expect(r).toHaveLength(3);
    const titles = r.map((e) => e.title).sort();
    expect(titles).toEqual(["ECB Rate Decision", "Global Risk Event", "US NFP"]);
  });

  it("sorts by absolute distance from trade time (closest first)", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 15,
    });
    // Closest = Global Risk Event (0 min), then US NFP (5 min), then ECB (10 min).
    expect(r[0].title).toBe("Global Risk Event");
    expect(r[0].minutesFromTrade).toBe(0);
    expect(r[1].title).toBe("US NFP");
    expect(r[1].minutesFromTrade).toBe(5);
    expect(r[2].title).toBe("ECB Rate Decision");
    expect(r[2].minutesFromTrade).toBe(-10);
  });

  it("excludes events that don't match the traded currencies", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 15,
    });
    expect(r.find((e) => e.title === "BoE Minutes")).toBeUndefined();
  });

  it("excludes MEDIUM-impact events when highImpactOnly is true (default)", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 15,
    });
    expect(r.find((e) => e.title === "US Trade Balance")).toBeUndefined();
  });

  it("includes MEDIUM-impact events when highImpactOnly is false", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 15,
      highImpactOnly: false,
    });
    expect(r.find((e) => e.title === "US Trade Balance")).toBeDefined();
  });

  it("returns global events ('*') for any asset", () => {
    const r = findRelevantHighImpactEvents({
      asset: "BTC/USD", // BTC isn't ISO 4217 → getCurrenciesFromAsset returns ['*']
      tradeTime,
      events,
      minutes: 15,
    });
    // BTC/USD → ['*']. Matches the global '*' event. NOT USD NFP (USD
    // doesn't match '*' explicitly — but '*' is a global wildcard from
    // the EVENT side, not the asset side. The asset side ['*'] only matches
    // events whose currency is '*'.
    expect(r.find((e) => e.title === "Global Risk Event")).toBeDefined();
    expect(r.find((e) => e.title === "US NFP")).toBeUndefined();
  });

  it("respects the minutes parameter", () => {
    // 5-min window → only events within 5 min of trade time.
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events,
      minutes: 5,
    });
    // Only Global Risk Event (0 min) and US NFP (5 min) — wait, 5 min is
    // boundary exclusive (5 < 5 is false). So only Global Risk Event (0 min).
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe("Global Risk Event");
  });

  it("empty events list → empty result", () => {
    const r = findRelevantHighImpactEvents({
      asset: "EUR/USD",
      tradeTime,
      events: [],
      minutes: 15,
    });
    expect(r).toEqual([]);
  });
});
