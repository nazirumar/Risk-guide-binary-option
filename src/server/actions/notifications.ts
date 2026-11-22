"use server";

/**
 * Phase 12 — Notification center + preferences.
 *
 * In-app notifications stored in the Notification table (Phase 1 schema).
 * Per-type toggles stored on User.notificationPrefs (JSON).
 *
 * Types + DEFAULT_PREFS live in @/server/lib/notification-types (outside the
 * "use server" file because Turbopack requires "use server" files to export
 * ONLY async functions).
 */
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  normalizeBriefingFrequency,
  normalizeBriefingTime,
  normalizeBriefingWeekday,
} from "@/lib/news/schedule";
import { requireUser } from "@/server/lib/require-user";
import type { NotificationPrefs } from "@/server/lib/notification-types";
import { DEFAULT_PREFS } from "@/server/lib/notification-types";

/** Internal: create a notification if the user's prefs allow in-app for this type. */
export async function createNotificationIfAllowed(
  userId: string,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const prefs = (user?.notificationPrefs as NotificationPrefs) ?? DEFAULT_PREFS;
  const pref = prefs[type] ?? { inApp: true, email: false };

  if (pref.inApp) {
    await db.notification.create({
      data: { userId, type, title, body },
    });
  }
}

/** Mark a single notification as read. */
export async function markNotificationReadAction(formData: FormData): Promise<{ ok: boolean }> {
  const { userId } = await requireUser();
  const notificationId = String(formData.get("notificationId") ?? "");
  await db.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/app");
  return { ok: true };
}

/** Mark all unread notifications as read. */
export async function markAllNotificationsReadAction(): Promise<{ ok: boolean }> {
  const { userId } = await requireUser();
  await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/app");
  return { ok: true };
}

/** Get the user's notification preferences (merged with defaults). */
export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const { userId } = await requireUser();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const stored = (user?.notificationPrefs as NotificationPrefs) ?? {};
  // Merge with defaults so new types appear even if the user hasn't saved.
  return { ...DEFAULT_PREFS, ...stored };
}

/** Update the user's notification preferences. */
export async function updateNotificationPrefsAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const { userId } = await requireUser();
  const existingUser = await db.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const existing = (existingUser?.notificationPrefs as NotificationPrefs) ?? {};
  const prefs: NotificationPrefs = {};
  for (const type of Object.keys(DEFAULT_PREFS)) {
    prefs[type] = {
      inApp: formData.get(`${type}_inApp`) === "on",
      email: formData.get(`${type}_email`) === "on",
      // Saving in-app/email must never silently wipe a Telegram opt-in or the
      // user's chosen briefing schedule.
      telegram: existing[type]?.telegram ?? DEFAULT_PREFS[type]?.telegram,
      ...(type === "NEWS_BRIEFING"
        ? {
            briefingTime: existing[type]?.briefingTime ?? DEFAULT_PREFS.NEWS_BRIEFING.briefingTime,
            briefingFrequency:
              existing[type]?.briefingFrequency ?? DEFAULT_PREFS.NEWS_BRIEFING.briefingFrequency,
            briefingWeekday:
              existing[type]?.briefingWeekday ?? DEFAULT_PREFS.NEWS_BRIEFING.briefingWeekday,
          }
        : {}),
    };
  }
  await db.user.update({
    where: { id: userId },
    data: { notificationPrefs: prefs as never },
  });
  revalidatePath("/app/settings");
  return { ok: true, message: "Notification preferences saved." };
}

/**
 * Save the optional news-briefing schedule. Channel toggles are untouched —
 * this action only changes when an already opted-in user receives the digest.
 */
export async function updateBriefingScheduleAction(input: {
  briefingTime: string;
  briefingFrequency: string;
  briefingWeekday: number | string;
}): Promise<{ ok: boolean; message: string }> {
  const { userId } = await requireUser();
  const time = normalizeBriefingTime(input?.briefingTime);
  const frequency = normalizeBriefingFrequency(input?.briefingFrequency);
  const weekday = normalizeBriefingWeekday(input?.briefingWeekday);
  if (!time || !frequency || weekday === null) {
    return { ok: false, message: "Choose a valid time, frequency and weekday." };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const existing = (user?.notificationPrefs as NotificationPrefs) ?? {};
  const current = existing.NEWS_BRIEFING ?? DEFAULT_PREFS.NEWS_BRIEFING;
  const prefs: NotificationPrefs = {
    ...existing,
    NEWS_BRIEFING: {
      ...current,
      briefingTime: time,
      briefingFrequency: frequency,
      briefingWeekday: weekday,
    },
  };
  await db.user.update({
    where: { id: userId },
    data: { notificationPrefs: prefs as never },
  });
  revalidatePath("/app/settings");
  return { ok: true, message: "News briefing schedule saved." };
}

/** Update trading hours settings. */
export async function updateTradingHoursAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const { userId } = await requireUser();
  const start = String(formData.get("start") ?? "09:00");
  const end = String(formData.get("end") ?? "17:00");
  const daysRaw = formData.getAll("days").map(Number);
  const days = daysRaw.length > 0 ? daysRaw : [1, 2, 3, 4, 5]; // Mon-Fri default
  await db.user.update({
    where: { id: userId },
    data: { tradingHours: { start, end, days } as never },
  });
  revalidatePath("/app/settings");
  return { ok: true, message: "Trading hours saved." };
}
