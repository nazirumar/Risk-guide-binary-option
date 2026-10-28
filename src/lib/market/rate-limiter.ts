type RateLimitConfig = {
  requestsPerMinute: number;
  requestsPerDay: number;
};

export class MarketRateLimiter {
  private requestsThisMinute: number[] = [];
  private requestsToday: number[] = [];
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig = { requestsPerMinute: 8, requestsPerDay: 800 }) {
    this.config = config;
  }

  async consume(providerName: string): Promise<void> {
    const now = Date.now();
    // Clean old entries
    this.requestsThisMinute = this.requestsThisMinute.filter((t) => now - t < 60 * 1000);
    this.requestsToday = this.requestsToday.filter((t) => now - t < 24 * 60 * 60 * 1000);

    if (this.requestsThisMinute.length >= this.config.requestsPerMinute) {
      const waitTime = 60 * 1000 - (now - this.requestsThisMinute[0]) + 100;
      await new Promise((r) => setTimeout(r, waitTime));
      return this.consume(providerName);
    }

    if (this.requestsToday.length >= this.config.requestsPerDay) {
      throw new Error(`Daily rate limit exceeded for ${providerName}`);
    }

    this.requestsThisMinute.push(now);
    this.requestsToday.push(now);
  }

  getBudget(): { minute: number; day: number } {
    const now = Date.now();
    this.requestsThisMinute = this.requestsThisMinute.filter((t) => now - t < 60 * 1000);
    this.requestsToday = this.requestsToday.filter((t) => now - t < 24 * 60 * 60 * 1000);
    return {
      minute: this.config.requestsPerMinute - this.requestsThisMinute.length,
      day: this.config.requestsPerDay - this.requestsToday.length,
    };
  }
}

export const marketRateLimiter = new MarketRateLimiter({
  requestsPerMinute: 8,
  requestsPerDay: 800,
});
export const oandaRateLimiter = new MarketRateLimiter({
  requestsPerMinute: 60,
  requestsPerDay: 5000,
});
