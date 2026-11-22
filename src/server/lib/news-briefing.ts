/**
 * Phase 30.4 — scheduled news briefing sweep.
 *
 * Called only by the CRON_SECRET-gated /api/cron/news-briefing route. Reads
 * precomputed global rows plus each opted-in user's own aggregates; never
 * constructs an AI/market provider and never fetches an external page.
 * Every channel is off by default via DEFAULT_PREFS.NEWS_BRIEFING. Users can
 * choose a time/frequency in Settings; the cron should run every 15 minutes.
 */
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { briefingEmailHtml, buildNewsBriefing, sanitizeBriefingCopy } from "@/lib/news/briefing";
import { isBriefingDue, localClockInTz } from "@/lib/news/schedule";
import { createNotificationIfAllowed } from "@/server/actions/notifications";
import { sendTelegramAlertAction } from "@/server/actions/telegram";
import { getMarketEdgeReport } from "@/server/lib/market-edge";
import { buildMarketSnapshot } from "@/server/lib/market-snapshot";
import { DEFAULT_PREFS, type NotificationPrefs } from "@/server/lib/notification-types";

export const BRIEFING_TYPE = "NEWS_BRIEFING" as const;

export type BriefingRunResult = {
  ok: boolean;
  eligibleUsers: number;
  inAppSent: number;
  emailSent: number;
  telegramSent: number;
  errors: string[];
  ranAt: string;
};

type BriefingUser = {
  id: string;
  email: string;
  timezone: string;
  notificationPrefs: unknown;
  telegramAlertsEnabled: boolean;
  telegramAlertsPaused: boolean;
  briefingTime?: string | null;
  briefingFrequency?: string | null;
  briefingWeekday?: number | null;
};

function prefFor(user: BriefingUser) {
  const stored = (user.notificationPrefs as NotificationPrefs) ?? {};
  return (
    { ...DEFAULT_PREFS, ...stored }[BRIEFING_TYPE] ?? {
      inApp: false,
      email: false,
      telegram: false,
    }
  );
}

/** True when the user opted into at least one briefing channel. */
export function isBriefingOptedIn(user: BriefingUser): boolean {
  const pref = prefFor(user);
  return Boolean(pref.inApp || pref.email || pref.telegram);
}

/**
 * Compose and deliver one short briefing per opted-in user. Failures on one
 * user never prevent delivery to the rest; all outcomes are audited on
 * `AgentRun.kind = "BRIEFING"`.
 */
export async function sendNewsBriefings(now: Date = new Date()): Promise<BriefingRunResult> {
  const startedAt = now;
  const ranAt = startedAt.toISOString();
  const empty: BriefingRunResult = {
    ok: true,
    eligibleUsers: 0,
    inAppSent: 0,
    emailSent: 0,
    telegramSent: 0,
    errors: [],
    ranAt,
  };

  try {
    const users = await db.user.findMany({
      select: {
        id: true,
        email: true,
        timezone: true,
        notificationPrefs: true,
        telegramAlertsEnabled: true,
        telegramAlertsPaused: true,
      },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });
    // Opt-in AND currently in the user's chosen time window. The cron runs
    // every 15 minutes, so each user is considered once per day/week.
    const optedIn = users.filter(
      (user) => isBriefingOptedIn(user) && isBriefingDue(prefFor(user), startedAt, user.timezone),
    );

    if (optedIn.length === 0) {
      await db.agentRun.create({
        data: {
          kind: "BRIEFING",
          provider: "system",
          status: "OK",
          itemsFound: 0,
          itemsStored: 0,
          startedAt,
          finishedAt: new Date(),
        },
      });
      return empty;
    }

    // Global inputs are fetched once, outside the per-user loop.
    const [snapshot, articles] = await Promise.all([
      buildMarketSnapshot(),
      db.newsArticle.findMany({
        where: { impact: "HIGH" },
        orderBy: { publishedAt: "desc" },
        take: 2,
        select: { title: true },
      }),
    ]);

    const result: BriefingRunResult = { ...empty, eligibleUsers: optedIn.length };

    for (const user of optedIn) {
      try {
        // A second cron invocation inside the same 15-minute window (or a
        // retry after a partial failure) must not deliver a second digest.
        const dayKey = localClockInTz(startedAt, user.timezone).dateKey;
        // Check the stored LOCAL day key, not a UTC midnight boundary: users
        // east of UTC see their 08:00 on the previous UTC day.
        const alreadySent = await db.auditLog.findFirst({
          where: {
            userId: user.id,
            action: "NEWS_BRIEFING_SENT",
            meta: { path: ["dayKey"], equals: dayKey },
          },
          select: { id: true },
        });
        if (alreadySent) continue;

        const edge = await getMarketEdgeReport(user.id, user.timezone || "UTC");
        const copy = sanitizeBriefingCopy(
          buildNewsBriefing({
            nextNewsTitle: snapshot.nextNews?.title,
            nextNewsCurrency: snapshot.nextNews?.currency,
            nextNewsMinutesTo: snapshot.nextNews?.minutesTo,
            marketRating: snapshot.pairs[0]?.rating ?? null,
            marketStale: snapshot.isStale,
            edgeInsight: edge.insights[0]?.text ?? null,
            recentHeadlines: articles.map((a) => a.title),
            generatedAt: startedAt,
          }),
        );

        const pref = prefFor(user);
        if (pref.inApp) {
          await createNotificationIfAllowed(user.id, BRIEFING_TYPE, copy.title, copy.body);
          result.inAppSent++;
        }
        if (pref.email) {
          await sendEmail({
            to: user.email,
            subject: copy.title,
            html: briefingEmailHtml(copy),
            text: copy.body,
          });
          result.emailSent++;
        }
        if (pref.telegram) {
          const sent = await sendTelegramAlertAction(user.id, BRIEFING_TYPE, copy.title, copy.body);
          if (sent.ok && sent.delivered) result.telegramSent++;
        }

        await db.auditLog.create({
          data: {
            userId: user.id,
            action: "NEWS_BRIEFING_SENT",
            entity: "User",
            entityId: user.id,
            meta: {
              dayKey,
              channels: {
                inApp: pref.inApp,
                email: pref.email,
                telegram: pref.telegram,
              },
            },
          },
        });
      } catch (error) {
        result.errors.push(
          `user ${user.id}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    const totalSent = result.inAppSent + result.emailSent + result.telegramSent;
    await db.agentRun.create({
      data: {
        kind: "BRIEFING",
        provider: "system",
        status: result.errors.length ? (totalSent > 0 ? "PARTIAL" : "FAILED") : "OK",
        itemsFound: result.eligibleUsers,
        itemsStored: totalSent,
        error: result.errors.length ? result.errors.slice(0, 5).join(" | ").slice(0, 500) : null,
        startedAt,
        finishedAt: new Date(),
      },
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Briefing sweep failed.";
    await db.agentRun.create({
      data: {
        kind: "BRIEFING",
        provider: "system",
        status: "FAILED",
        itemsFound: 0,
        itemsStored: 0,
        error: message.slice(0, 500),
        startedAt,
        finishedAt: new Date(),
      },
    });
    return { ...empty, ok: false, errors: [message] };
  }
}
