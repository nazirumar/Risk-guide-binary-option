import { MarketRateLimiter } from "./rate-limiter";

export type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  bid?: number;
  ask?: number;
};

export type Instrument = {
  symbol: string;
  base: string;
  quote: string;
  pipSize: number;
  isActive: boolean;
  isMajor: boolean;
};

export type CredentialCheck = { ok: boolean; detail: string };

export interface MarketDataProvider {
  readonly name: string;
  getCandles(pair: string, granularity: string, from: Date, to: Date): Promise<Candle[]>;
  getInstruments(): Promise<Instrument[]>;
  streamPrices?(
    pairs: string[],
    onTick: (tick: { pair: string; bid: number; ask: number; time: Date }) => void,
  ): void;
  /** Optional: verify the configured API credentials (server-side only). */
  validateCredentials?(): Promise<CredentialCheck>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Deriv — market data over the public, no-auth WebSocket.
//
// Verified against the live API (2026-10-29):
//   • Public endpoint: wss://api.derivws.com/trading/v1/options/ws/public
//     — candles need NO authentication; `req_id` is echoed so several chunk
//       requests can be pipelined over one connection.
//   • Legacy endpoint: wss://ws.derivws.com/websockets/v3?app_id=… (fallback,
//     used when the primary is unreachable; also accepts `authorize`).
//   • REST (https://api.derivws.com) is account/wallet/health only — it has NO
//     ticks_history route (GET /api/v1/ticks_history 301-redirects to the docs
//     site), so candle history MUST go over WebSocket.
//   • `end` is REQUIRED on every ticks_history request, and `count` is capped
//     at 1000 candles → long ranges (e.g. the 30-day backfill) are chunked.
// ──────────────────────────────────────────────────────────────────────────────

const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const DERIV_LEGACY_WS = "wss://ws.derivws.com/websockets/v3";
const DERIV_REST_BASE = "https://api.derivws.com";
/** New API caps `count` at 1000 candles per ticks_history request. */
const DERIV_MAX_CANDLES_PER_REQUEST = 1000;
const DERIV_REQUEST_TIMEOUT_MS = 15_000;
/** Safety cap so a bad window can never loop forever (32 × 1000 candles). */
const DERIV_MAX_CHUNKS = 32;

const DERIV_SYMBOL_MAP: Record<string, string> = {
  EUR_USD: "frxEURUSD",
  GBP_USD: "frxGBPUSD",
  USD_JPY: "frxUSDJPY",
  AUD_USD: "frxAUDUSD",
  USD_CAD: "frxUSDCAD",
  USD_CHF: "frxUSDCHF",
  NZD_USD: "frxNZDUSD",
  EUR_GBP: "frxEURGBP",
  EUR_JPY: "frxEURJPY",
  GBP_JPY: "frxGBPJPY",
  USD_NOK: "frxUSDNOK",
  USD_SEK: "frxUSDSEK",
};

function normalizeDerivSymbol(pair: string): string {
  const normalized = pair.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return DERIV_SYMBOL_MAP[normalized] ?? `frx${normalized}`;
}

function normalizeDerivGranularity(granularity: string): number {
  const value = granularity.trim().toUpperCase();
  if (value === "M1") return 60;
  if (value === "M5") return 300;
  if (value === "M15") return 900;
  if (value === "M30") return 1800;
  if (value === "H1") return 3600;
  if (value === "H2") return 7200;
  if (value === "H4") return 14400;
  if (value === "D" || value === "1D") return 86400;
  if (value === "W" || value === "1W") return 604800;

  // "5M" / "1H" style (and bare "5" → 5 minutes, the historical behavior).
  const minutes = /^(\d+)M?$/.exec(value);
  if (minutes) return Number(minutes[1]) * 60;
  const hours = /^(\d+)H$/.exec(value);
  if (hours) return Number(hours[1]) * 3600;

  return 300;
}

type DerivCandleResponse = {
  req_id?: number;
  msg_type?: string;
  candles?: Array<{ epoch: number; open: number; high: number; low: number; close: number; volume?: number }>;
  error?: { code?: string; message?: string };
};

export class DerivProvider implements MarketDataProvider {
  readonly name = "Deriv";

  /** Endpoint that answered last — tried first so we don't re-probe every call. */
  private static preferredEndpoint: string | null = null;

  constructor(
    private readonly appId?: string,
    private readonly token?: string,
  ) {}

  /** Test hook: forget which endpoint worked last. */
  static resetEndpointCache(): void {
    DerivProvider.preferredEndpoint = null;
  }

  private endpoints(): string[] {
    const candidates: string[] = [];
    if (DerivProvider.preferredEndpoint) candidates.push(DerivProvider.preferredEndpoint);
    candidates.push(DERIV_PUBLIC_WS);
    if (this.appId) candidates.push(`${DERIV_LEGACY_WS}?app_id=${encodeURIComponent(this.appId)}`);
    return [...new Set(candidates)];
  }

  /**
   * Open one socket, pipeline every request over it (matched by `req_id`) and
   * resolve once all responses arrived. Falls through to the next endpoint when
   * a connection cannot be established.
   */
  private requestCandleChunks(
    requests: Array<Record<string, unknown>>,
  ): Promise<Map<number, NonNullable<DerivCandleResponse["candles"]>>> {
    const endpoints = this.endpoints();

    const attempt = (endpoint: string) =>
      new Promise<Map<number, NonNullable<DerivCandleResponse["candles"]>>>((resolve, reject) => {
        let ws: WebSocket;
        try {
          ws = new WebSocket(endpoint);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }

        const out = new Map<number, NonNullable<DerivCandleResponse["candles"]>>();
        const pending = new Set(requests.map((r) => r.req_id as number));
        let settled = false;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          if (err) reject(err);
          else resolve(out);
        };

        const timer = setTimeout(
          () => finish(new Error(`Deriv: no response within ${DERIV_REQUEST_TIMEOUT_MS}ms (${endpoint})`)),
          DERIV_REQUEST_TIMEOUT_MS,
        );

        ws.onopen = () => {
          for (const req of requests) ws.send(JSON.stringify(req));
        };

        ws.onmessage = (event) => {
          let msg: DerivCandleResponse;
          try {
            msg = JSON.parse(String(event.data)) as DerivCandleResponse;
          } catch {
            return; // ignore non-JSON keep-alives
          }
          // Any API-level error fails the whole batch (chunk requests are pipelined).
          if (msg.error) {
            finish(
              new Error(
                `Deriv ${msg.error.code ?? "error"}: ${msg.error.message ?? "candle fetch failed"}`,
              ),
            );
            return;
          }
          if (msg.req_id == null || msg.msg_type !== "candles") return;
          out.set(msg.req_id, msg.candles ?? []);
          pending.delete(msg.req_id);
          if (pending.size === 0) finish();
        };

        ws.onerror = () => finish(new Error(`Deriv: WebSocket connection failed (${endpoint})`));
        ws.onclose = () => finish(new Error(`Deriv: connection closed before a response (${endpoint})`));
      });

    return (async () => {
      let lastError: Error | null = null;
      for (const endpoint of endpoints) {
        try {
          const result = await attempt(endpoint);
          DerivProvider.preferredEndpoint = endpoint;
          return result;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
        }
      }
      throw lastError ?? new Error("Deriv: no endpoint available");
    })();
  }

  async getCandles(pair: string, granularity: string, from: Date, to: Date): Promise<Candle[]> {
    const symbol = normalizeDerivSymbol(pair);
    const granularitySeconds = normalizeDerivGranularity(granularity);

    const end = Math.min(Math.floor(to.getTime() / 1000), Math.floor(Date.now() / 1000));
    const start = Math.floor(from.getTime() / 1000);
    if (end <= start) return [];

    // Walk backwards in ≤1000-candle windows (the API's count cap).
    const windowSeconds = DERIV_MAX_CANDLES_PER_REQUEST * granularitySeconds;
    const requests: Array<Record<string, unknown>> = [];
    let chunkEnd = end;
    let reqId = 1;
    while (chunkEnd > start && requests.length < DERIV_MAX_CHUNKS) {
      const chunkStart = Math.max(start, chunkEnd - windowSeconds);
      requests.push({
        req_id: reqId++,
        ticks_history: symbol,
        style: "candles",
        granularity: granularitySeconds,
        start: chunkStart,
        end: chunkEnd,
      });
      chunkEnd = chunkStart;
    }

    const chunks = await this.requestCandleChunks(requests);

    // Merge, de-duplicate (adjacent windows share a boundary) and sort ascending.
    const byTime = new Map<number, Candle>();
    for (const candles of chunks.values()) {
      for (const c of candles) {
        const epoch = Number(c.epoch);
        if (!Number.isFinite(epoch)) continue;
        const time = new Date(epoch * 1000);
        if (time < from || time > to) continue;
        byTime.set(epoch, {
          time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume ?? 0),
        });
      }
    }

    return [...byTime.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
  }

  async getInstruments(): Promise<Instrument[]> {
    return Object.keys(DERIV_SYMBOL_MAP).map((symbol) => ({
      symbol,
      base: symbol.split("_")[0],
      quote: symbol.split("_")[1],
      pipSize: symbol.includes("JPY") ? 0.01 : 0.0001,
      isActive: true,
      isMajor: true,
    }));
  }

  /**
   * Verify the PAT + app id against Deriv's REST API (server-side only).
   * Market data itself is public/no-auth; this just proves the configured key
   * is valid so a revoked token is visible in the worker log instead of silent.
   */
  async validateCredentials(): Promise<CredentialCheck> {
    if (!this.token) {
      return {
        ok: true,
        detail: "no DERIV_API_TOKEN configured — public market data works without a key",
      };
    }
    try {
      const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Deriv-App-ID": this.appId ?? "",
        },
      });
      if (!res.ok) {
        return { ok: false, detail: `Deriv REST ${res.status} — check DERIV_API_TOKEN / DERIV_APP_ID` };
      }
      const body = (await res.json()) as { data?: Array<{ account_type?: string; status?: string }> };
      const account = body.data?.[0];
      return {
        ok: true,
        detail: account
          ? `token accepted (${account.account_type ?? "account"}${account.status ? `, ${account.status}` : ""})`
          : "token accepted",
      };
    } catch (e) {
      return { ok: false, detail: `Deriv REST unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "TwelveData";
  constructor(
    private readonly apiKey: string,
    private readonly limiter: MarketRateLimiter = new MarketRateLimiter({
      requestsPerMinute: 8,
      requestsPerDay: 800,
    }),
  ) {}
  async getCandles(pair: string, granularity: string, from: Date, to: Date): Promise<Candle[]> {
    // Respect the 8 req/min + 800 req/day plan limits before hitting the API.
    await this.limiter.consume(this.name);
    const interval = granularity.toLowerCase();
    const url = `https://api.twelvedata.com/time_series?symbol=${pair.replace("_", "/")}&interval=${interval}&start_date=${from.toISOString()}&end_date=${to.toISOString()}&apikey=${this.apiKey}`;
    const res = await fetch(url);
    if (res.status === 429) {
      // Surface a clear, retryable signal so the worker backs off instead of crashing.
      throw new Error("TwelveData rate limited (429)");
    }
    if (!res.ok) throw new Error(`TwelveData ${res.status}`);
    const data = (await res.json()) as { values?: Array<Record<string, unknown>> };
    return (data.values ?? []).map((v) => ({
      time: new Date(String(v.datetime)),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume ?? 0),
    }));
  }
  async getInstruments(): Promise<Instrument[]> {
    return [];
  }
  getBudget() {
    return this.limiter.getBudget();
  }
}

/**
 * Provider resolution from config (`MARKET_PROVIDER`).
 *
 * Revised Phase 26: Deriv is the default (OANDA is unavailable in Nigeria);
 * TwelveData remains an optional fallback when explicitly selected.
 */
export function getMarketProvider(): MarketDataProvider {
  const name = process.env.MARKET_PROVIDER?.toLowerCase();

  if (name === "twelvedata" && process.env.TWELVEDATA_API_KEY) {
    return new TwelveDataProvider(process.env.TWELVEDATA_API_KEY);
  }

  if (name !== "twelvedata") {
    return new DerivProvider(process.env.DERIV_APP_ID, process.env.DERIV_API_TOKEN);
  }

  // MARKET_PROVIDER=twelvedata but no key → degrade to Deriv (public data).
  return new DerivProvider(process.env.DERIV_APP_ID, process.env.DERIV_API_TOKEN);
}
