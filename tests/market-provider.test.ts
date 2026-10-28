import { describe, it, expect, vi, beforeEach } from "vitest";
import { OandaProvider, TwelveDataProvider } from "@/lib/market/provider";
import { MarketRateLimiter } from "@/lib/market/rate-limiter";

describe("Market providers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("OandaProvider fetches candles", async () => {
    const mockRes = {
      ok: true,
      json: async () => ({
        candles: [
          {
            time: "2023-01-01T00:00:00Z",
            mid: { o: "1.0", h: "1.1", l: "0.9", c: "1.05" },
            volume: 100,
          },
        ],
      }),
    };
    global.fetch = vi.fn().mockResolvedValue(mockRes as any);
    const p = new OandaProvider("token", "practice");
    const candles = await p.getCandles(
      "EUR_USD",
      "M5",
      new Date("2023-01-01"),
      new Date("2023-01-02"),
    );
    expect(candles.length).toBe(1);
    expect(candles[0].open).toBe(1.0);
  });

  it("handles OANDA errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as any);
    const p = new OandaProvider("token", "practice");
    await expect(p.getCandles("EUR_USD", "M5", new Date(), new Date())).rejects.toThrow();
  });

  it("TwelveDataProvider formats symbols", async () => {
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
    expect(global.fetch).toHaveBeenCalled();
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
