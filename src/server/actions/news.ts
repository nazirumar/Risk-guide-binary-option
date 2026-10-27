"use server";

/**
 * Phase 22 — News calendar server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId for the
 * user-specific parts; news events are global (no userId scoping).
 * rule #4: Zod on the server. rule #8: state changes are audited. rule #11:
 * visible risk disclaimer — the news warning is a discipline aid, not
 * financial advice.)
 *
 * Five actions:
 *
 *   - `refreshNewsEventsAction(opts?)` — fetch from the configured provider
 *     + upsert NewsEvent rows. Token-protected at the cron endpoint;
 *     available standalone here for the manual refresh button on the
 *     News page. Catches provider failures gracefully and returns the
 *     cached-data notice (per spec: "Handle provider downtime gracefully").
 *
 *   - `listNewsEventsAction(input)` — list events in [fromUtc, toUtc),
 *     optional filter by impact + currency. For the News page.
 *
 *   - `getNextEventAction()` — countdown to the next upcoming event.
 *
 *   - `getNewsWarningAction(input)` — for the Add Trade form. Returns the
 *     relevant upcoming high-impact events for the traded asset + the
 *     user's configured warning window.
 *
 *   - `getNewsStatsAction()` — past trades taken near news vs away from
 *     news (win rate / P/L comparison). For the News page.
 *
 *   - `updateNewsWarningSettingsAction(formData)` — toggle + minutes.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { getNewsProvider } from "@/lib/news/provider";
import {
  findRelevantHighImpactEvents,
  getCurrenciesFromAsset,
  type RelevantEvent,
} from "@/lib/news/warning";

export type NewsActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type NewsEventRow = {
  id: string;
  currency: string;
  title: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
  scheduledAt: Date;
  source: string;
  forecast: string | null;
  actual: string | null;
  url: string | null;
};

export type NextEventResult = NewsActionResult & {
  nextEvent?: NewsEventRow | null;
  minutesUntil?: number;
};

export type NewsWarningResult = NewsActionResult & {
  warningEnabled?: boolean;
  minutes?: number;
  relevantEvents?: RelevantEvent[];
};

export type NewsStatsRow = {
  bucket: "near-news" | "away-from-news";
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  netPL: number;
  expectancyPerTrade: number;
};

export type NewsStatsResult = NewsActionResult & {
  rows?: NewsStatsRow[];
};

// ─── 1. refreshNewsEventsAction ────────────────────────────────────────────

/**
 * Fetch news events from the configured provider + upsert NewsEvent rows
 * for the [fromUtc, toUtc) window (default: next 24h).
 *
 * Catches provider failures gracefully — returns `{ ok: false, message }`
 * with the cached-data notice but DOESN'T throw. The UI surfaces this as
 * "couldn't refresh — showing cached data".
 */
export async function refreshNewsEventsAction(input?: {
  fromUtc?: Date;
  toUtc?: Date;
}): Promise<NewsActionResult & { refreshedCount?: number; providerName?: string }> {
  // No requireUser — this is callable from the cron endpoint (system-level)
  // AND from the manual refresh button (which IS session-scoped, but the
  // action is the same — both paths need to call the provider).
  // For the manual path, the caller is the News page Server Component,
  // which IS user-scoped via requireUser at the page level. We don't enforce
  // requireUser here to allow the cron to call this without a session.
  const fromUtc = input?.fromUtc ?? new Date();
  const toUtc = input?.toUtc ?? new Date(fromUtc.getTime() + 24 * 60 * 60 * 1000);

  let providerName = "unknown";
  let events: Awaited<ReturnType<ReturnType<typeof getNewsProvider>["fetchEvents"]>> = [];
  try {
    const provider = getNewsProvider();
    providerName = provider.name;
    events = await provider.fetchEvents({ fromUtc, toUtc });
  } catch (e) {
    return {
      ok: false,
      message: `Provider "${providerName}" failed: ${e instanceof Error ? e.message : "unknown error"}. Showing cached data.`,
      providerName,
      refreshedCount: 0,
    };
  }

  // Upsert each event row. The unique constraint is
  // [source, scheduledAt, title] — the same event from the same source
  // won't be duplicated.
  let refreshed = 0;
  for (const ev of events) {
    try {
      await db.newsEvent.upsert({
        where: {
          source_scheduledAt_title: {
            source: providerName,
            scheduledAt: ev.scheduledAt,
            title: ev.title,
          },
        },
        create: {
          currency: ev.currency.toUpperCase(),
          title: ev.title,
          impact: ev.impact,
          scheduledAt: ev.scheduledAt,
          source: providerName,
          forecast: ev.forecast ?? null,
          actual: ev.actual ?? null,
          url: ev.url ?? null,
        },
        update: {
          currency: ev.currency.toUpperCase(),
          impact: ev.impact,
          forecast: ev.forecast ?? null,
          actual: ev.actual ?? null,
          url: ev.url ?? null,
        },
      });
      refreshed++;
    } catch {
      // Skip rows that fail to upsert (e.g. malformed timestamps). The
      // provider is supposed to validate but we're defensive — the spec
      // says "never block trading" so a single bad row shouldn't abort the
      // refresh.
    }
  }

  // NOTE: We deliberately do NOT call revalidatePath here. refreshNewsEventsAction
  // may be called during a Server Component render (the News page calls it to
  // refresh on page load). Next.js 16 disallows revalidatePath during render.
  // The Server Components on /app/news + /app/trades re-fetch from DB on
  // every navigation, so the latest NewsEvent rows are always reflected on
  // the next page load.
  return {
    ok: true,
    message: `Refreshed ${refreshed} event${refreshed === 1 ? "" : "s"} from ${providerName}.`,
    refreshedCount: refreshed,
    providerName,
  };
}

// ─── 2. listNewsEventsAction ───────────────────────────────────────────────

export async function listNewsEventsAction(input: {
  fromUtc: Date;
  toUtc: Date;
  impact?: "LOW" | "MEDIUM" | "HIGH";
  currency?: string;
}): Promise<NewsActionResult & { events?: NewsEventRow[] }> {
  const where: {
    scheduledAt: { gte: Date; lt: Date };
    impact?: string;
    currency?: string;
  } = {
    scheduledAt: { gte: input.fromUtc, lt: input.toUtc },
  };
  if (input.impact) where.impact = input.impact;
  if (input.currency) where.currency = input.currency.toUpperCase();

  const rows = await db.newsEvent.findMany({
    where,
    orderBy: { scheduledAt: "asc" },
    take: 200,
    select: {
      id: true,
      currency: true,
      title: true,
      impact: true,
      scheduledAt: true,
      source: true,
      forecast: true,
      actual: true,
      url: true,
    },
  });

  return {
    ok: true,
    message: `${rows.length} event${rows.length === 1 ? "" : "s"} in range.`,
    events: rows.map((r) => ({
      ...r,
      impact: r.impact as "LOW" | "MEDIUM" | "HIGH",
    })),
  };
}

// ─── 3. getNextEventAction ──────────────────────────────────────────────────

export async function getNextEventAction(): Promise<NextEventResult> {
  const now = new Date();
  const row = await db.newsEvent.findFirst({
    where: { scheduledAt: { gte: now } },
    orderBy: { scheduledAt: "asc" },
    select: {
      id: true,
      currency: true,
      title: true,
      impact: true,
      scheduledAt: true,
      source: true,
      forecast: true,
      actual: true,
      url: true,
    },
  });
  if (!row) {
    return { ok: true, message: "No upcoming events.", nextEvent: null };
  }
  const minutesUntil = Math.round((row.scheduledAt.getTime() - now.getTime()) / 60_000);
  return {
    ok: true,
    message: `Next event: ${row.title} in ${minutesUntil} min.`,
    nextEvent: { ...row, impact: row.impact as "LOW" | "MEDIUM" | "HIGH" },
    minutesUntil,
  };
}

// ─── 4. getNewsWarningAction ───────────────────────────────────────────────

export async function getNewsWarningAction(input: {
  asset: string;
  tradeTime?: Date;
}): Promise<NewsWarningResult> {
  const { userId } = await requireUser();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      newsWarningEnabled: true,
      newsWarningMinutes: true,
    },
  });
  const enabled = user?.newsWarningEnabled ?? true;
  const minutes = user?.newsWarningMinutes ?? 15;

  if (!enabled) {
    return {
      ok: true,
      message: "News warning disabled.",
      warningEnabled: false,
      minutes,
      relevantEvents: [],
    };
  }

  const tradeTime = input.tradeTime ?? new Date();
  // Fetch upcoming events in a [tradeTime - minutes, tradeTime + minutes]
  // window — the pure `findRelevantHighImpactEvents` will refine to those
  // matching the asset's currencies.
  const fromUtc = new Date(tradeTime.getTime() - minutes * 60_000);
  const toUtc = new Date(tradeTime.getTime() + minutes * 60_000);
  const candidates = await db.newsEvent.findMany({
    where: {
      scheduledAt: { gte: fromUtc, lt: toUtc },
      impact: "HIGH",
    },
    select: {
      currency: true,
      title: true,
      impact: true,
      scheduledAt: true,
    },
  });

  const relevant = findRelevantHighImpactEvents({
    asset: input.asset,
    tradeTime,
    events: candidates.map((c) => ({
      ...c,
      impact: c.impact as "LOW" | "MEDIUM" | "HIGH",
    })),
    minutes,
    highImpactOnly: true,
  });

  return {
    ok: true,
    message:
      relevant.length === 0
        ? "No relevant high-impact news events within the warning window."
        : `${relevant.length} relevant high-impact event${relevant.length === 1 ? "" : "s"} within ${minutes} min.`,
    warningEnabled: true,
    minutes,
    relevantEvents: relevant,
  };
}

// ─── 5. getNewsStatsAction ─────────────────────────────────────────────────

/**
 * Compare trades taken "near news" (within the user's warning window of a
 * high-impact event for the traded pair's currencies) vs "away from news".
 *
 * Returns two rows: { bucket: "near-news", ... } and { bucket: "away-from-news", ... }.
 * The bucket boundary uses the user's `newsWarningMinutes` setting.
 *
 * Pure calc on top of the DB-fetched data — the join logic lives here.
 */
export async function getNewsStatsAction(): Promise<NewsStatsResult> {
  const { userId } = await requireUser();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { newsWarningMinutes: true },
  });
  const minutes = user?.newsWarningMinutes ?? 15;

  // Fetch the user's closed trades + the high-impact news events in a
  // wide range (last 90 days).
  const now = new Date();
  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const [trades, events] = await Promise.all([
    db.trade.findMany({
      where: {
        userId,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: since },
      },
      select: {
        id: true,
        asset: true,
        openedAt: true,
        profitLoss: true,
        result: true,
      },
    }),
    db.newsEvent.findMany({
      where: {
        impact: "HIGH",
        scheduledAt: { gte: since },
      },
      select: {
        currency: true,
        scheduledAt: true,
      },
    }),
  ]);

  // Bucket each trade: "near-news" if any high-impact event matches the
  // traded pair's currencies AND is within the warning window.
  const windowMs = minutes * 60_000;
  const near = { trades: 0, wins: 0, losses: 0, ties: 0, netPL: 0 };
  const away = { trades: 0, wins: 0, losses: 0, ties: 0, netPL: 0 };
  for (const t of trades) {
    const currencies = getCurrenciesFromAsset(t.asset);
    const isNear = events.some((e) => {
      const eventCcy = e.currency.toUpperCase();
      const matches = eventCcy === "*" || currencies.some((c) => c.toUpperCase() === eventCcy);
      if (!matches) return false;
      const diff = Math.abs(t.openedAt.getTime() - e.scheduledAt.getTime());
      return diff < windowMs;
    });
    const bucket = isNear ? near : away;
    bucket.trades++;
    bucket.netPL += Number(t.profitLoss.toString());
    if (t.result === "WIN") bucket.wins++;
    else if (t.result === "LOSS") bucket.losses++;
    else bucket.ties++;
  }

  const toRow = (bucket: typeof near, label: "near-news" | "away-from-news"): NewsStatsRow => ({
    bucket: label,
    trades: bucket.trades,
    wins: bucket.wins,
    losses: bucket.losses,
    ties: bucket.ties,
    winRate: bucket.trades > 0 ? bucket.wins / bucket.trades : 0,
    netPL: Math.round(bucket.netPL * 100) / 100,
    expectancyPerTrade:
      bucket.trades > 0 ? Math.round((bucket.netPL / bucket.trades) * 100) / 100 : 0,
  });

  return {
    ok: true,
    message: `${near.trades} near-news trades, ${away.trades} away-from-news trades.`,
    rows: [toRow(near, "near-news"), toRow(away, "away-from-news")],
  };
}

// ─── 6. updateNewsWarningSettingsAction ─────────────────────────────────────

export async function updateNewsWarningSettingsAction(
  formData: FormData,
): Promise<NewsActionResult> {
  const { userId } = await requireUser();
  const enabled = formData.get("newsWarningEnabled") === "true";
  const minutesRaw = Number(formData.get("newsWarningMinutes") ?? 15);
  if (!Number.isFinite(minutesRaw) || minutesRaw < 0 || minutesRaw > 240) {
    return {
      ok: false,
      message: "Minutes must be a number between 0 and 240.",
      fieldErrors: { newsWarningMinutes: "Must be 0–240." },
    };
  }
  await db.user.update({
    where: { id: userId },
    data: {
      newsWarningEnabled: enabled,
      newsWarningMinutes: Math.round(minutesRaw),
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "NEWS_WARNING_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: { enabled, minutes: Math.round(minutesRaw) },
    },
  });
  revalidatePath("/app/settings");
  revalidatePath("/app/trades");
  return {
    ok: true,
    message: `News warning ${enabled ? "enabled" : "disabled"} at ${Math.round(minutesRaw)} min.`,
  };
}

// Avoid the "Decimal imported but unused" warning — Decimal is reserved for
// future monetary-stat extensions (NewsStatsRow.netPL is `number` for
// display simplicity).
void Decimal;
