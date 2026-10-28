/**
 * Pure economic-calendar provider interface for Phase 22 — Sessions & News.
 *
 * The interface is intentionally minimal so that any provider (ForexFactory,
 * Investing, custom internal feed, etc.) can be swapped in by implementing
 * `NewsProvider`. The DB caching layer (`refreshNewsEventsAction` server
 * action) is the source of truth for the UI; the provider is only called
 * by the cron job to refresh the cache.
 *
 * Production wiring:
 *   - `ConsoleNewsProvider`: dev fallback — generates no events (returns
 *     an empty array) so the UI always shows "no events today" without
 *     crashing. Useful in dev when no real provider is configured.
 *   - A future `ForexFactoryProvider` would implement the interface and
 *     fetch from the ForexFactory RSS / JSON feed. Adding it is a matter
 *     of writing the provider class + setting an env var — no UI changes.
 *
 * (PROJECT_RULES.md rule #2: pure helpers live in /src/lib — this file
 * declares the interface + factory; concrete providers are pure + tested
 * separately. rule #11: visible risk disclaimer — the news warning is a
 * discipline aid, not financial advice.)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type NewsImpact = "LOW" | "MEDIUM" | "HIGH";

export type NewsEventInput = {
  /** ISO 4217 currency code ("USD", "EUR", "GBP", "JPY", "AUD", ...) or "*"
   *  for global events. */
  currency: string;
  title: string;
  impact: NewsImpact;
  /** UTC scheduled time. */
  scheduledAt: Date;
  forecast?: string | null;
  actual?: string | null;
  url?: string | null;
};

export type FetchEventsOptions = {
  /** Lower bound (inclusive) for scheduledAt. */
  fromUtc: Date;
  /** Upper bound (exclusive) for scheduledAt. */
  toUtc: Date;
  /** Optional filter by currency. */
  currencies?: string[];
  /** Optional filter by impact. */
  impact?: NewsImpact;
};

// ─── Interface ───────────────────────────────────────────────────────────────

export interface NewsProvider {
  /** Unique identifier — used as the `source` field on NewsEvent rows. */
  readonly name: string;

  /**
   * Fetch events in the [fromUtc, toUtc) window. Returns an array of
   * `NewsEventInput` rows (caller upserts into the DB).
   *
   * Implementations MUST:
   *   - Never throw — wrap network errors in a thrown Error with a clear
   *     message; the caller (`refreshNewsEventsAction`) catches and falls
   *     back to cached data with a notice. (Spec: "Handle provider
   *     downtime gracefully — show cached data and a notice, never block
   *     trading.")
   *   - Return at most ~500 events per call (cap for perf).
   */
  fetchEvents(opts: FetchEventsOptions): Promise<NewsEventInput[]>;
}

// ─── ConsoleNewsProvider (dev fallback) ───────────────────────────────────────

/**
 * Dev-only news provider — returns an empty event list. Use this in
 * environments without a real news API key. The UI then shows "No events
 * scheduled today" without crashing.
 *
 * Tests use this provider by default — the integration test seeds events
 * directly into the DB to verify the warning logic.
 */
export class ConsoleNewsProvider implements NewsProvider {
  readonly name = "ConsoleProvider";

  async fetchEvents(_opts: FetchEventsOptions): Promise<NewsEventInput[]> {
    // Dev: log a one-line message so a developer can see that the news
    // page is using the fallback provider. (Production MUST set a real
    // provider env var — see the factory below.)
    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[NewsProvider] Console fallback in use — set NEWS_PROVIDER to enable a real provider.",
      );
    }
    return [];
  }
}

// ─── Finnhub provider ────────────────────────────────────────────────────────
export class FinnhubNewsProvider implements NewsProvider {
  readonly name = "Finnhub";
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  async fetchEvents(opts: FetchEventsOptions): Promise<NewsEventInput[]> {
    try {
      const from = opts.fromUtc.toISOString().slice(0, 10);
      const to = opts.toUtc.toISOString().slice(0, 10);
      const res = await fetch(
        `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${this.apiKey}`,
      );
      if (!res.ok) throw new Error(`Finnhub ${res.status}`);
      const data = (await res.json()) as { economicCalendar?: Array<Record<string, unknown>> };
      const events = data.economicCalendar ?? [];
      return events.slice(0, 500).map((e) => ({
        currency: String(e.currency ?? "*"),
        title: String(e.event ?? "Event"),
        impact: (String(e.impact ?? "LOW").toUpperCase() as NewsImpact) || "LOW",
        scheduledAt: new Date(String(e.time ?? new Date().toISOString())),
        forecast: e.estimate != null ? String(e.estimate) : null,
        actual: e.actual != null ? String(e.actual) : null,
        url: null,
      }));
    } catch (e) {
      throw new Error(`Finnhub fetch failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

let _provider: NewsProvider | null = null;

/**
 * Resolve the configured news provider. Resolution order:
 *   1. If a test pre-registered a provider via `setNewsProvider`, use it.
 *   2. If `NEWS_PROVIDER` env var is set to "forexfactory", construct a
 *      ForexFactoryProvider (not implemented yet — falls back to Console).
 *   3. Otherwise: ConsoleNewsProvider (dev default).
 *
 * The factory is a singleton — the same provider instance is reused across
 * calls in the same process.
 */
export function getNewsProvider(): NewsProvider {
  if (_provider) return _provider;
  const name = process.env.NEWS_PROVIDER?.toLowerCase();
  switch (name) {
    case "finnhub": {
      const key = process.env.FINNHUB_API_KEY;
      if (key) {
        _provider = new FinnhubNewsProvider(key);
      } else {
        _provider = new ConsoleNewsProvider();
      }
      break;
    }
      // TODO Phase 22+: implement ForexFactoryProvider when an API key
      // is available. For now, fall back to Console.
      _provider = new ConsoleNewsProvider();
      break;
    case "console":
    case undefined:
    case "":
    case null:
      _provider = new ConsoleNewsProvider();
      break;
    default:
      // Unknown provider name — log + fall back to Console. Better than
      // crashing the whole app on a typo in the env var.
      console.warn(
        `[NewsProvider] Unknown NEWS_PROVIDER "${name}" — falling back to ConsoleProvider.`,
      );
      _provider = new ConsoleNewsProvider();
      break;
  }
  return _provider;
}

/**
 * Test-only: register a custom provider (e.g. a mock for unit/integration
 * tests). Resets the singleton so the next `getNewsProvider()` returns the
 * new provider.
 */
export function setNewsProvider(provider: NewsProvider | null): void {
  _provider = provider;
}
