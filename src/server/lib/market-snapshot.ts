/**
 * Phase 28 — Live market-conditions snapshot builder (server-only, shared).
 *
 * (PROJECT_RULES.md rule #3: the market rows themselves are global — no userId
 * — but this module is only reachable from authed pages / authed route
 * handlers. rule #11: wording stays descriptive.)
 *
 * One builder, four consumers — SSR page, "Market now" widget, the SSE
 * broadcaster, and the 30s polling fallback — so every surface shows identical
 * numbers. It reads ONLY the DB (never the provider): the worker pre-computes
 * `MarketCondition` once per minute for every pair, so more users never means
 * more provider calls (spec).
 */
import { db } from "@/lib/db";
import { isMarketClosed } from "@/lib/market/market-hours";
import { MARKET_ALERT_COOLDOWN_MINUTES } from "@/lib/market/condition-alerts";
import { HEATMAP_MIN_SAMPLE_DAYS } from "@/lib/market/scoring-config";

/** Ratings whose volatility percentile bar is green/amber/red. */
export type Rating = "GOOD" | "CAUTION" | "AVOID";

export type MarketSnapshotNewsEvent = {
  id: string;
  currency: string;
  title: string;
  impact: string;
  scheduledAt: string;
  minutesTo: number;
};

export type MarketSnapshotPair = {
  instrumentId: string;
  symbol: string;
  displayName: string;
  score: number;
  rating: Rating;
  factors: Array<{
    key: string;
    label: string;
    score: number | null;
    weight: number;
    note: string;
    percentile?: number | null;
  }>;
  reasons: string[];
  computedAt: string;
  /** Seconds since `computedAt` — the "updated 12s ago" value. */
  ageSeconds: number;
  /** Display metadata from `MarketCondition.meta` (null on pre-Phase-28 rows). */
  session: string | null;
  spread: number | null;
  typicalSpread: number | null;
  spreadRatio: number | null;
  volatilityPercentile: number | null;
  marketClosed: boolean;
  nextNewsTitle: string | null;
  nextNewsMinutesTo: number | null;
  newsKnown: boolean;
  /** True when this pair has enough heatmap samples to be meaningfully ranked. */
  heatmapReady: boolean;
};

export type MarketSnapshot = {
  serverTime: string;
  /** Provider/worker considered stale → ratings grey out + banner shows. */
  isStale: boolean;
  /** Age of the newest `MarketCondition.computedAt`, in seconds (null if none). */
  dataAgeSeconds: number | null;
  provider: string | null;
  /** Seconds since the provider's last successful poll (null if never). */
  providerLagSeconds: number | null;
  providerLastError: string | null;
  marketClosed: boolean;
  pairs: MarketSnapshotPair[];
  /** Next HIGH-impact news across all currencies (drives the widget). */
  nextNews: MarketSnapshotNewsEvent | null;
};

/** Beyond this age the ratings are considered stale (grey + banner). */
export const MARKET_STALE_SECONDS = 180;

function ratingOf(raw: string): Rating {
  return raw === "GOOD" || raw === "AVOID" ? raw : "CAUTION";
}

function displayNameOf(symbol: string): string {
  return symbol.replace("_", "/");
}

/**
 * Build the live snapshot. Never throws — a DB hiccup degrades to an empty
 * (stale) snapshot rather than a 500 on a dashboard that users keep open.
 */
export async function buildMarketSnapshot(now: Date = new Date()): Promise<MarketSnapshot> {
  const [conditions, statuses] = await Promise.all([
    db.marketCondition.findMany({
      include: {
        instrument: {
          select: {
            symbol: true,
            isActive: true,
            hourlyStats: { select: { sampleDays: true } },
          },
        },
      },
    }),
    db.marketDataStatus.findMany(),
  ]);

  const nowMs = now.getTime();

  const pairs: MarketSnapshotPair[] = conditions
    .filter((c) => c.instrument?.isActive !== false)
    .map((c) => {
      const meta = (c.meta ?? null) as Record<string, unknown> | null;
      const factors = (Array.isArray(c.factors) ? c.factors : []) as MarketSnapshotPair["factors"];
      const vol = factors.find((f) => f.key === "volatility");
      const ageSeconds = Math.max(0, Math.floor((nowMs - c.computedAt.getTime()) / 1000));
      const maxSampleDays = c.instrument.hourlyStats.reduce((m, s) => Math.max(m, s.sampleDays), 0);
      return {
        instrumentId: c.instrumentId,
        symbol: c.instrument.symbol,
        displayName: displayNameOf(c.instrument.symbol),
        score: c.score,
        rating: ratingOf(c.rating),
        factors,
        reasons: Array.isArray(c.reasons) ? (c.reasons as string[]) : [],
        computedAt: c.computedAt.toISOString(),
        ageSeconds,
        session: (meta?.session as string) ?? null,
        spread: (meta?.currentSpread as number) ?? null,
        typicalSpread: (meta?.typicalSpread as number) ?? null,
        spreadRatio: (meta?.spreadRatio as number) ?? null,
        volatilityPercentile: (meta?.volatilityPercentile as number) ?? vol?.percentile ?? null,
        marketClosed: (meta?.marketClosed as boolean) ?? isMarketClosed(now),
        nextNewsTitle: (meta?.nextNewsTitle as string) ?? null,
        nextNewsMinutesTo: (meta?.nextNewsMinutesTo as number) ?? null,
        newsKnown: (meta?.newsKnown as boolean) ?? false,
        heatmapReady: maxSampleDays >= HEATMAP_MIN_SAMPLE_DAYS,
      };
    })
    .sort((a, b) => b.score - a.score);

  const dataAgeSeconds = pairs.length > 0 ? Math.min(...pairs.map((p) => p.ageSeconds)) : null;
  const isStale = dataAgeSeconds == null || dataAgeSeconds > MARKET_STALE_SECONDS;

  const primary = statuses.find((s) => s.lastSuccessAt) ?? statuses[0] ?? null;
  const providerLagSeconds = primary?.lastSuccessAt
    ? Math.max(0, Math.floor((nowMs - primary.lastSuccessAt.getTime()) / 1000))
    : null;
  const providerLastError =
    primary?.lastErrorAt && primary.lastError
      ? `Last error ${Math.floor((nowMs - primary.lastErrorAt.getTime()) / 1000)}s ago: ${primary.lastError}`
      : null;

  const nextNews = await buildNextNews(now);

  return {
    serverTime: now.toISOString(),
    isStale,
    dataAgeSeconds,
    provider: primary?.provider ?? null,
    providerLagSeconds,
    providerLastError,
    marketClosed: isMarketClosed(now),
    pairs,
    nextNews,
  };
}

/** Next HIGH-impact news event at/after `now` (across all currencies). */
async function buildNextNews(now: Date): Promise<MarketSnapshotNewsEvent | null> {
  const event = await db.newsEvent.findFirst({
    where: { scheduledAt: { gte: now }, impact: { in: ["HIGH", "High", "high"] } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!event) return null;
  return {
    id: event.id,
    currency: event.currency,
    title: event.title,
    impact: event.impact,
    scheduledAt: event.scheduledAt.toISOString(),
    minutesTo: Math.max(0, Math.round((event.scheduledAt.getTime() - now.getTime()) / 60_000)),
  };
}

/**
 * The user's favorite instrument ids (for the star + the GOOD-only filter). Kept
 * separate from the snapshot because it IS user-scoped (rule #3).
 */
export async function getFavoriteInstrumentIds(userId: string): Promise<string[]> {
  const rows = await db.marketFavorite.findMany({
    where: { userId },
    select: { instrumentId: true },
  });
  return rows.map((r) => r.instrumentId);
}

export { MARKET_ALERT_COOLDOWN_MINUTES };
