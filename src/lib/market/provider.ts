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

export interface MarketDataProvider {
  readonly name: string;
  getCandles(pair: string, granularity: string, from: Date, to: Date): Promise<Candle[]>;
  getInstruments(): Promise<Instrument[]>;
  streamPrices?(
    pairs: string[],
    onTick: (tick: { pair: string; bid: number; ask: number; time: Date }) => void,
  ): void;
}

export class OandaProvider implements MarketDataProvider {
  readonly name = "OANDA";
  constructor(
    private readonly token: string,
    private readonly env: "practice" | "live",
  ) {}
  async getCandles(pair: string, granularity: string, from: Date, to: Date): Promise<Candle[]> {
    const host = this.env === "live" ? "api-fxtrade.oanda.com" : "api-fxpractice.oanda.com";
    const url = `https://${host}/v3/instruments/${pair}/candles?granularity=${granularity}&from=${from.toISOString()}&to=${to.toISOString()}&price=BA`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`OANDA ${res.status}`);
    const data = (await res.json()) as { candles?: Array<Record<string, unknown>> };
    return (data.candles ?? []).map((c) => ({
      time: new Date(String(c.time)),
      open: Number((c.mid as Record<string, unknown>)?.o ?? c.o),
      high: Number((c.mid as Record<string, unknown>)?.h ?? c.h),
      low: Number((c.mid as Record<string, unknown>)?.l ?? c.l),
      close: Number((c.mid as Record<string, unknown>)?.c ?? c.c),
      volume: Number(c.volume ?? 0),
    }));
  }
  async getInstruments(): Promise<Instrument[]> {
    return [];
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

export function getMarketProvider(): MarketDataProvider {
  const name = process.env.MARKET_PROVIDER?.toLowerCase();
  if (name === "oanda" && process.env.OANDA_TOKEN) {
    return new OandaProvider(
      process.env.OANDA_TOKEN,
      (process.env.OANDA_ENV as "practice" | "live") ?? "practice",
    );
  }
  if (name === "twelvedata" && process.env.TWELVEDATA_API_KEY) {
    return new TwelveDataProvider(process.env.TWELVEDATA_API_KEY);
  }
  // Default/fallback
  if (process.env.OANDA_TOKEN) {
    return new OandaProvider(
      process.env.OANDA_TOKEN,
      (process.env.OANDA_ENV as "practice" | "live") ?? "practice",
    );
  }
  if (process.env.TWELVEDATA_API_KEY) {
    return new TwelveDataProvider(process.env.TWELVEDATA_API_KEY);
  }
  return new OandaProvider("", "practice");
}
