import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DerivProvider,
  TwelveDataProvider,
  getMarketProvider,
  type Candle,
} from "@/lib/market/provider";
import { MarketRateLimiter } from "@/lib/market/rate-limiter";

// ─── WebSocket double ────────────────────────────────────────────────────────
// Deriv candles come over a WebSocket (verified against the live API), so the
// provider is tested against a scriptable socket instead of a fetch mock.
type MockMessage = Record<string, unknown>;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  /** Called for every payload the provider sends — reply through `respond`. */
  static onSend: (url: string, payload: MockMessage, socket: MockWebSocket) => void = () => {};

  url: string;
  sent: MockMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // The provider assigns handlers synchronously, so open on a later tick.
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    const payload = JSON.parse(data) as MockMessage;
    this.sent.push(payload);
    MockWebSocket.onSend(this.url, payload, this);
  }

  close() {}

  respond(msg: MockMessage) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }

  fail() {
    setTimeout(() => this.onerror?.(new Error("connection failed")), 0);
  }

  static reset() {
    MockWebSocket.instances = [];
    MockWebSocket.onSend = () => {};
  }
}

const CANDLE = { epoch: 1672531200, open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 100 };

const candlesReply = (payload: MockMessage, candles = [CANDLE]) => ({
  req_id: payload.req_id,
  msg_type: "candles",
  candles,
});

describe("DerivProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.reset();
    DerivProvider.resetEndpointCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches candles over the public WebSocket and maps OHLC", async () => {
    MockWebSocket.onSend = (_url, payload, socket) => socket.respond(candlesReply(payload));

    const p = new DerivProvider("1000", "pat_test");
    const candles = await p.getCandles(
      "EUR_USD",
      "M5",
      new Date("2023-01-01T00:00:00Z"),
      new Date("2023-01-01T00:05:00Z"),
    );

    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(1.0);
    expect(candles[0].close).toBe(1.05);
    expect(candles[0].time).toBeInstanceOf(Date);
    expect(MockWebSocket.instances[0].url).toContain("api.derivws.com");
    expect(MockWebSocket.instances[0].sent[0]).toMatchObject({
      ticks_history: "frxEURUSD",
      style: "candles",
      granularity: 300,
    });
  });

  it("sends the required end parameter on every request", async () => {
    MockWebSocket.onSend = (_url, payload, socket) => socket.respond(candlesReply(payload));

    const p = new DerivProvider();
    await p.getCandles(
      "GBP_JPY",
      "M1",
      new Date(Date.now() - 5 * 60 * 1000),
      new Date(),
    );

    const sent = MockWebSocket.instances[0].sent;
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(typeof req.end).toBe("number");
      expect(typeof req.start).toBe("number");
    }
    expect(sent[0].ticks_history).toBe("frxGBPJPY");
    expect(sent[0].granularity).toBe(60);
  });

  it("chunks a 30-day M5 backfill into <=1000-candle windows", async () => {
    MockWebSocket.onSend = (_url, payload, socket) => socket.respond(candlesReply(payload));

    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const p = new DerivProvider();
    await p.getCandles("EUR_USD", "M5", from, now);

    const sent = MockWebSocket.instances[0].sent;
    // 30 days of M5 = 8640 candles → 9 windows of ≤1000 candles (300 000 s each).
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(32);
    for (const req of sent) {
      const seconds = (req.end as number) - (req.start as number);
      expect(seconds).toBeLessThanOrEqual(1000 * 300);
    }
    // Windows walk backwards and tile the whole range without gaps.
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].end).toBe(sent[i - 1].start);
    }
    expect(sent[sent.length - 1].start).toBeLessThanOrEqual(Math.floor(from.getTime() / 1000));
  });

  it("deduplicates and sorts candles that arrive across chunks", async () => {
    const base = 1672531200;
    MockWebSocket.onSend = (_url, payload, socket) =>
      socket.respond(
        candlesReply(payload, [
          { ...CANDLE, epoch: base + 300 },
          { ...CANDLE, epoch: base },
          { ...CANDLE, epoch: base + 300 }, // duplicate boundary candle
        ]),
      );

    const p = new DerivProvider();
    const candles: Candle[] = await p.getCandles(
      "EUR_USD",
      "M5",
      new Date((base - 60) * 1000),
      new Date((base + 600) * 1000),
    );

    expect(candles.map((c) => c.time.getTime())).toEqual([
      base * 1000,
      (base + 300) * 1000,
    ]);
  });

  it("falls back to the app-id endpoint when the primary is unreachable", async () => {
    MockWebSocket.onSend = (url, payload, socket) => {
      if (url.includes("api.derivws.com")) socket.fail();
      else socket.respond(candlesReply(payload));
    };

    const p = new DerivProvider("1000");
    const candles = await p.getCandles(
      "EUR_USD",
      "M5",
      new Date(Date.now() - 10 * 60 * 1000),
      new Date(),
    );

    expect(candles).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("app_id=1000");
  });

  it("surfaces Deriv API errors", async () => {
    MockWebSocket.onSend = (_url, payload, socket) =>
      socket.respond({
        req_id: payload.req_id,
        msg_type: "error",
        error: { code: "InputValidationFailed", message: "bad granularity" },
      });

    const p = new DerivProvider();
    await expect(
      p.getCandles("EUR_USD", "M5", new Date(Date.now() - 60_000), new Date()),
    ).rejects.toThrow(/InputValidationFailed/);
  });

  it("validateCredentials reports a missing token as non-fatal", async () => {
    const p = new DerivProvider();
    const res = await p.validateCredentials!();
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/no DERIV_API_TOKEN/);
  });

  it("validateCredentials checks the PAT against Deriv REST", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ account_type: "demo", status: "active" }] }),
    }) as any;

    const p = new DerivProvider("1000", "pat_test");
    const res = await p.validateCredentials!();
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/token accepted \(demo, active\)/);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/trading/v1/options/accounts"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer pat_test",
          "Deriv-App-ID": "1000",
        }),
      }),
    );
  });

  it("validateCredentials reports an invalid token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as any;

    const p = new DerivProvider("1000", "pat_bad");
    const res = await p.validateCredentials!();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/401/);
  });
});

describe("getMarketProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Deriv when MARKET_PROVIDER=deriv", () => {
    vi.stubEnv("MARKET_PROVIDER", "deriv");
    vi.stubEnv("DERIV_APP_ID", "1000");
    vi.stubEnv("DERIV_API_TOKEN", "pat_x");
    expect(getMarketProvider()).toBeInstanceOf(DerivProvider);
  });

  it("uses TwelveData only when explicitly selected with a key", () => {
    vi.stubEnv("MARKET_PROVIDER", "twelvedata");
    vi.stubEnv("TWELVEDATA_API_KEY", "key");
    expect(getMarketProvider()).toBeInstanceOf(TwelveDataProvider);
  });

  it("defaults to Deriv (public, no key required)", () => {
    vi.stubEnv("MARKET_PROVIDER", "");
    vi.stubEnv("DERIV_APP_ID", "");
    vi.stubEnv("DERIV_API_TOKEN", "");
    expect(getMarketProvider()).toBeInstanceOf(DerivProvider);
  });
});

describe("TwelveDataProvider", () => {
  it("formats symbols and maps the response", async () => {
    const mockRes = {
      ok: true,
      json: async () => ({
        values: [
          {
            datetime: "2023-01-01 00:00:00",
            open: "1.0",
            high: "1.1",
            low: "0.9",
            close: "1.05",
            volume: "100",
          },
        ],
      }),
    };
    global.fetch = vi.fn().mockResolvedValue(mockRes as any);
    const p = new TwelveDataProvider("key");
    const candles = await p.getCandles("EUR_USD", "1h", new Date(), new Date());
    expect(candles.length).toBe(1);
    expect(candles[0].open).toBe(1.0);
    expect(global.fetch).toHaveBeenCalled();
  });

  it("throws a retryable error on 429", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as any);
    const p = new TwelveDataProvider("key");
    await expect(p.getCandles("EUR_USD", "1h", new Date(), new Date())).rejects.toThrow(/429/);
  });
});

describe("Rate limiter", () => {
  it("tracks remaining minute/day budget", async () => {
    const rl = new MarketRateLimiter({ requestsPerMinute: 5, requestsPerDay: 10 });
    expect(rl.getBudget()).toEqual({ minute: 5, day: 10 });
    await rl.consume("test");
    await rl.consume("test");
    expect(rl.getBudget()).toEqual({ minute: 3, day: 8 });
  });

  it("throws when the daily budget is exhausted", async () => {
    const rl = new MarketRateLimiter({ requestsPerMinute: 100, requestsPerDay: 2 });
    await rl.consume("test");
    await rl.consume("test");
    await expect(rl.consume("test")).rejects.toThrow(/Daily rate limit exceeded/);
  });
});
