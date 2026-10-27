/**
 * Pure news-warning logic for Phase 22 — Sessions & News.
 *
 * (PROJECT_RULES.md rule #2: pure helpers. These functions are DB-free —
 * the server action calls them with the cached NewsEvent rows.)
 *
 * The Add Trade flow asks: "Is this trade within X minutes of a high-impact
 * news event that affects one of the traded pair's currencies?" The pure
 * functions here answer that question deterministically.
 *
 * Exports:
 *   - `getCurrenciesFromAsset(asset)`: extract the two currency codes
 *     from a forex pair like "EUR/USD" → ["EUR", "USD"]. Falls back to
 *     ["*"] for non-forex assets (e.g. "BTC/USD", "GOLD") so global
 *     events still warn.
 *   - `isEventRelevantForCurrencies(event, currencies)`: returns true iff
 *     the event's currency matches any of the traded pair's currencies
 *     (or the event is global "*").
 *   - `findRelevantHighImpactEvents(opts)`: the main entry point — given
 *     the upcoming events, the traded asset, a target trade time, and a
 *     warning window in minutes, returns the list of relevant upcoming
 *     high-impact events.
 *   - `isWithinWarningWindow(tradeTime, eventTime, minutes)`: pure boundary
 *     check — within `minutes` before OR after the event.
 */

export type NewsEventForWarning = {
  currency: string;
  title: string;
  impact: string;
  scheduledAt: Date;
};

// ─── Asset → currencies ──────────────────────────────────────────────────────

/**
 * Extract the two currency codes from a forex pair like "EUR/USD", "GBPJPY",
 * "AUD/USD". Returns ["*"] for non-forex assets so global events still
 * warn (e.g. "BTC/USD", "GOLD", "XAU/USD" — these aren't standard ISO
 * 4217 pairs and we don't want to silently skip high-impact global news).
 *
 * Accepts both slash-separated ("EUR/USD") and concatenated ("GBPJPY") forms.
 * Concatenated forms only match if both halves are known ISO 4217 codes.
 *
 * Examples:
 *   getCurrenciesFromAsset("EUR/USD") → ["EUR", "USD"]
 *   getCurrenciesFromAsset("GBPJPY")  → ["GBP", "JPY"] (concatenated, both known)
 *   getCurrenciesFromAsset("BTC/USD") → ["*"] (BTC is not ISO 4217)
 *   getCurrenciesFromAsset("GOLD")    → ["*"]
 *   getCurrenciesFromAsset("")        → ["*"]
 */
export function getCurrenciesFromAsset(asset: string): string[] {
  const trimmed = asset.trim().toUpperCase();
  if (!trimmed) return ["*"];

  // Slash-separated form: "EUR/USD"
  if (trimmed.includes("/")) {
    const [a, b] = trimmed.split("/").map((s) => s.trim());
    if (isIso4217Currency(a) && isIso4217Currency(b)) {
      return [a, b];
    }
    // If either side isn't a known currency (e.g. "BTC/USD"), fall back to
    // global — we don't want to silently skip high-impact global news.
    return ["*"];
  }

  // Concatenated form: "GBPJPY" — try 3+3 split first (most forex pairs).
  // ISO 4217 codes are all 3 letters, so we just need to find a 3-letter
  // boundary that splits into two known codes.
  if (trimmed.length === 6) {
    const a = trimmed.slice(0, 3);
    const b = trimmed.slice(3, 6);
    if (isIso4217Currency(a) && isIso4217Currency(b)) {
      return [a, b];
    }
  }

  // Unknown format — treat as global so high-impact global events still warn.
  return ["*"];
}

/**
 * Check whether `code` is a known ISO 4217 currency code. We hard-code the
 * most common ~40 codes (covers >99% of binary-options pairs). Any
 * non-listed 3-letter code is treated as non-currency (e.g. "BTC", "ETH").
 */
const ISO_4217_CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "CHF",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "MXN",
  "ZAR",
  "SGD",
  "HKD",
  "TRY",
  "BRL",
  "RUB",
  "INR",
  "CNY",
  "KRW",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "BGN",
  "ISK",
  "HRK",
  "ILS",
  "PHP",
  "IDR",
  "MYR",
  "THB",
  "VND",
  "TWD",
  "KZT",
  "UAH",
  "AED",
  "SAR",
  "CLP",
]);

export function isIso4217Currency(code: string): boolean {
  return ISO_4217_CURRENCIES.has(code.toUpperCase());
}

// ─── Relevance check ─────────────────────────────────────────────────────────

/**
 * Returns true iff the event is relevant to any of the traded currencies.
 *
 * Examples:
 *   isEventRelevantForCurrencies({ currency: "USD", ... }, ["EUR", "USD"]) → true
 *   isEventRelevantForCurrencies({ currency: "EUR", ... }, ["EUR", "USD"]) → true
 *   isEventRelevantForCurrencies({ currency: "GBP", ... }, ["EUR", "USD"]) → false
 *   isEventRelevantForCurrencies({ currency: "*", ... }, ["EUR", "USD"]) → true (global event)
 */
export function isEventRelevantForCurrencies(
  event: Pick<NewsEventForWarning, "currency">,
  currencies: string[],
): boolean {
  const eventCcy = event.currency.toUpperCase();
  if (eventCcy === "*") return true;
  return currencies.some((c) => c.toUpperCase() === eventCcy);
}

// ─── Within-warning-window check ─────────────────────────────────────────────

/**
 * Returns true iff `tradeTime` is within `minutes` minutes (inclusive)
 * before OR after `eventTime`. The "before OR after" semantics cover both
 * the pre-event anticipation (don't trade 5 min before NFP) and the
 * post-event volatility window (don't trade 5 min after a rate decision
 * until the dust settles).
 *
 * Examples:
 *   isWithinWarningWindow(13:55, 14:00, 15) → true (5 min before)
 *   isWithinWarningWindow(14:00, 14:00, 15) → true (exactly at event)
 *   isWithinWarningWindow(14:14, 14:00, 15) → true (14 min after)
 *   isWithinWarningWindow(14:15, 14:00, 15) → false (15 min after — boundary, exclusive)
 *   isWithinWarningWindow(13:44, 14:00, 15) → false (16 min before — boundary, exclusive)
 */
export function isWithinWarningWindow(tradeTime: Date, eventTime: Date, minutes: number): boolean {
  const diffMs = Math.abs(tradeTime.getTime() - eventTime.getTime());
  const windowMs = minutes * 60_000;
  return diffMs < windowMs; // strict less-than (boundary exclusive)
}

// ─── Main entry: find relevant upcoming high-impact events ───────────────────

export type FindRelevantEventsInput = {
  /** The asset being traded (e.g. "EUR/USD"). */
  asset: string;
  /** The intended trade open time. */
  tradeTime: Date;
  /** Upcoming events (caller fetches from DB — already filtered to future
   *  events relative to tradeTime, but we'll re-check the window here). */
  events: NewsEventForWarning[];
  /** Warning window in minutes (default 15). */
  minutes?: number;
  /** Optional filter: only include HIGH-impact events (default true). */
  highImpactOnly?: boolean;
};

export type RelevantEvent = NewsEventForWarning & {
  /** Minutes from tradeTime to the event (positive = event is in the future;
   *  negative = past). */
  minutesFromTrade: number;
};

/**
 * Find the relevant upcoming news events for a trade. Returns the events
 * that:
 *   - Match the traded pair's currencies (or are global "*").
 *   - Are within the warning window (before OR after the trade time).
 *   - Are high-impact (unless `highImpactOnly` is false).
 *
 * The result is sorted by scheduled time ascending — the closest event
 * first.
 *
 * Examples:
 *   asset="EUR/USD", tradeTime=14:00, minutes=15
 *   events=[{title:"NFP", currency:"USD", impact:"HIGH", scheduledAt:14:05}]
 *   → returns [{...NFP, minutesFromTrade: 5}] (USD matches, within 15-min window)
 *
 *   asset="EUR/USD", tradeTime=14:00, minutes=15
 *   events=[{title:"BoE Rate", currency:"GBP", impact:"HIGH", scheduledAt:14:05}]
 *   → returns [] (GBP doesn't match EUR or USD)
 */
export function findRelevantHighImpactEvents(input: FindRelevantEventsInput): RelevantEvent[] {
  const minutes = input.minutes ?? 15;
  const highImpactOnly = input.highImpactOnly ?? true;
  const currencies = getCurrenciesFromAsset(input.asset);
  const out: RelevantEvent[] = [];
  for (const e of input.events) {
    // Filter by impact (unless highImpactOnly is false).
    if (highImpactOnly && e.impact.toUpperCase() !== "HIGH") continue;
    if (!isEventRelevantForCurrencies(e, currencies)) continue;
    if (!isWithinWarningWindow(input.tradeTime, e.scheduledAt, minutes)) continue;
    const minutesFromTrade = Math.round(
      (e.scheduledAt.getTime() - input.tradeTime.getTime()) / 60_000,
    );
    out.push({ ...e, minutesFromTrade });
  }
  // Sort by absolute distance from trade time (closest first).
  out.sort((a, b) => Math.abs(a.minutesFromTrade) - Math.abs(b.minutesFromTrade));
  return out;
}
