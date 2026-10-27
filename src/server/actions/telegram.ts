"use server";

/**
 * Phase 23 — Telegram alerts server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId. rule #8:
 * state changes are audited.)
 *
 * Seven actions:
 *
 *   - `generateLinkCodeAction()`      — one-time code for /start CODE.
 *   - `unlinkTelegramAction()`        — delete the TelegramLink row.
 *   - `updateTelegramAlertsAction(formData)` — master switch + per-alert
 *       toggles + daily summary time.
 *   - `sendTelegramAlertAction(userId, alertType, title, body)` — send via
 *       the provider (checks master switch + paused + per-alert toggle).
 *       System-level — no requireUser (called by other actions/crons with
 *       an explicit userId).
 *   - `handleTelegramWebhookAction(update)` — process /start CODE, /status,
 *       /stop, /help commands. Called by the webhook route.
 *   - `buildStatusMessageAction(userId)` — the /status response text.
 *   - `sendDailySummariesAction()` — cron-friendly: send daily summaries
 *       to all opted-in users at their chosen time.
 */
import Decimal from "decimal.js";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount } from "@/server/actions/active-account";
import {
  getTelegramProvider,
  parseTelegramCommand,
  generateLinkCode,
} from "@/lib/telegram/provider";
import {
  DEFAULT_PREFS,
  TELEGRAM_ALERT_TYPES,
  type NotificationPrefs,
} from "@/server/lib/notification-types";
import { dayKeyInTz, shiftDayKey } from "@/lib/behavior/discipline";

export type TelegramActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type LinkCodeResult = TelegramActionResult & {
  code?: string;
  expiresAt?: string;
};

// ─── 1. generateLinkCodeAction ──────────────────────────────────────────────

export async function generateLinkCodeAction(): Promise<LinkCodeResult> {
  const { userId } = await requireUser();
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + 15 * 60_000); // 15 min
  await db.user.update({
    where: { id: userId },
    data: { telegramLinkCode: code, telegramLinkCodeExpiresAt: expiresAt },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "TELEGRAM_LINK_CODE_GENERATED",
      entity: "User",
      entityId: userId,
      meta: { codePrefix: code.slice(0, 5) }, // don't log the full code
    },
  });
  return {
    ok: true,
    message: "Link code generated. Send /start CODE to the bot within 15 minutes.",
    code,
    expiresAt: expiresAt.toISOString(),
  };
}

// ─── 2. unlinkTelegramAction ────────────────────────────────────────────────

export async function unlinkTelegramAction(): Promise<TelegramActionResult> {
  const { userId } = await requireUser();
  const existing = await db.telegramLink.findUnique({ where: { userId } });
  if (!existing) {
    return { ok: false, message: "No Telegram account linked." };
  }
  await db.telegramLink.delete({ where: { userId } });
  await db.auditLog.create({
    data: {
      userId,
      action: "TELEGRAM_UNLINKED",
      entity: "TelegramLink",
      entityId: existing.id,
      meta: { chatId: existing.chatId },
    },
  });
  return { ok: true, message: "Telegram account unlinked." };
}

// ─── 3. updateTelegramAlertsAction ──────────────────────────────────────────

export async function updateTelegramAlertsAction(
  formData: FormData,
): Promise<TelegramActionResult> {
  const { userId } = await requireUser();
  const enabled = formData.get("telegramAlertsEnabled") === "true";
  const dailySummaryTimeRaw = String(formData.get("telegramDailySummaryTime") ?? "");
  const dailySummaryTime = dailySummaryTimeRaw.trim() === "" ? null : dailySummaryTimeRaw;

  // Validate the time format (HH:MM).
  if (dailySummaryTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailySummaryTime)) {
    return {
      ok: false,
      message: "Daily summary time must be HH:MM (24h).",
      fieldErrors: { telegramDailySummaryTime: "Invalid time format." },
    };
  }

  // Build the per-alert toggles from the form.
  const current = await db.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const prefs: NotificationPrefs = {
    ...DEFAULT_PREFS,
    ...((current?.notificationPrefs as NotificationPrefs) ?? {}),
  };
  for (const type of TELEGRAM_ALERT_TYPES) {
    const existing = prefs[type] ?? { inApp: true, email: false, telegram: true };
    prefs[type] = {
      ...existing,
      telegram: formData.get(`${type}_telegram`) === "on",
    };
  }

  await db.user.update({
    where: { id: userId },
    data: {
      telegramAlertsEnabled: enabled,
      telegramDailySummaryTime: dailySummaryTime,
      notificationPrefs: prefs as never,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "TELEGRAM_ALERTS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: { enabled, dailySummaryTime },
    },
  });
  return { ok: true, message: "Telegram alert settings saved." };
}

// ─── 4. sendTelegramAlertAction ──────────────────────────────────────────────

/**
 * Send a Telegram alert to a user. System-level — no requireUser (called
 * by other actions/crons with an explicit userId).
 *
 * Checks:
 *   1. The user has a verified TelegramLink.
 *   2. User.telegramAlertsEnabled is true.
 *   3. User.telegramAlertsPaused is false.
 *   4. The per-alert toggle for `alertType` is on (default true when unset).
 *
 * Never throws — returns { ok: false, message } on any failure (the
 * notification fire-and-forget contract: a Telegram outage shouldn't break
 * the calling action).
 */
export async function sendTelegramAlertAction(
  userId: string,
  alertType: string,
  title: string,
  body: string,
): Promise<TelegramActionResult & { delivered?: boolean }> {
  try {
    const [user, link] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          telegramAlertsEnabled: true,
          telegramAlertsPaused: true,
          notificationPrefs: true,
        },
      }),
      db.telegramLink.findUnique({ where: { userId } }),
    ]);
    if (!link) {
      return { ok: false, message: "No Telegram link." };
    }
    if (!user?.telegramAlertsEnabled) {
      return { ok: false, message: "Telegram alerts disabled." };
    }
    if (user.telegramAlertsPaused) {
      return { ok: false, message: "Telegram alerts paused (/stop)." };
    }
    const prefs = {
      ...DEFAULT_PREFS,
      ...((user.notificationPrefs as NotificationPrefs) ?? {}),
    };
    const pref = prefs[alertType] ?? { inApp: true, email: false, telegram: true };
    if (pref.telegram === false) {
      return { ok: false, message: `Telegram alerts for ${alertType} are off.` };
    }

    const provider = getTelegramProvider();
    const text = `<b>${title}</b>\n${body}`;
    await provider.sendMessage(link.chatId, text);
    return { ok: true, message: "Alert delivered.", delivered: true };
  } catch (e) {
    return {
      ok: false,
      message: `Telegram send failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

// ─── 5. handleTelegramWebhookAction ─────────────────────────────────────────

/**
 * Process a Telegram webhook update. The route handler verifies the secret
 * header BEFORE calling this action.
 *
 * Commands:
 *   /start CODE → link the account (code lookup, expiry check, chat-in-use check)
 *   /start      → resume paused alerts
 *   /status     → respond with balance + today's P/L + risk meter
 *   /stop       → pause alerts
 *   /help       → command list
 */
export async function handleTelegramWebhookAction(
  update: import("@/lib/telegram/provider").TelegramUpdate,
): Promise<TelegramActionResult> {
  const msg = update.message;
  if (!msg || !msg.text) {
    return { ok: true, message: "No text message — ignored." };
  }
  const chatId = String(msg.chat.id);
  const command = parseTelegramCommand(msg.text);
  const provider = getTelegramProvider();
  const username = msg.from?.username ?? null;

  switch (command.kind) {
    case "start": {
      if (command.code) {
        return handleLinkCommand(chatId, command.code, provider, username);
      }
      // /start without a code → resume paused alerts.
      const link = await db.telegramLink.findUnique({ where: { chatId } });
      if (!link) {
        await provider.sendMessage(
          chatId,
          "⚠ This chat isn't linked to a RiskGuard account yet. Generate a link code in Settings → Telegram, then send /start CODE.",
        );
        return { ok: true, message: "No link for this chat." };
      }
      await db.user.update({
        where: { id: link.userId },
        data: { telegramAlertsPaused: false },
      });
      await provider.sendMessage(
        chatId,
        "✅ Alerts resumed. You'll receive RiskGuard alerts again.",
      );
      return { ok: true, message: "Alerts resumed." };
    }
    case "status": {
      const link = await db.telegramLink.findUnique({ where: { chatId } });
      if (!link) {
        await provider.sendMessage(
          chatId,
          "⚠ This chat isn't linked. Send /start CODE to link it (code from Settings → Telegram).",
        );
        return { ok: true, message: "No link for this chat." };
      }
      const statusText = await buildStatusMessageAction(link.userId);
      await provider.sendMessage(chatId, statusText);
      return { ok: true, message: "Status sent." };
    }
    case "stop": {
      const link = await db.telegramLink.findUnique({ where: { chatId } });
      if (!link) {
        await provider.sendMessage(
          chatId,
          "⚠ This chat isn't linked. Send /start CODE to link it first.",
        );
        return { ok: true, message: "No link for this chat." };
      }
      await db.user.update({
        where: { id: link.userId },
        data: { telegramAlertsPaused: true },
      });
      await provider.sendMessage(
        chatId,
        "⏸ Alerts paused. Send /start to resume. Your account stays linked.",
      );
      return { ok: true, message: "Alerts paused." };
    }
    case "help": {
      await provider.sendMessage(
        chatId,
        `<b>RiskGuard bot commands</b>\n\n` +
          `/start CODE — link your account (code from Settings)\n` +
          `/start — resume paused alerts\n` +
          `/status — balance, today's P/L, risk meter\n` +
          `/stop — pause alerts (account stays linked)\n` +
          `/help — this message\n\n` +
          `<i>RiskGuard is a discipline tool, not financial advice.</i>`,
      );
      return { ok: true, message: "Help sent." };
    }
    default: {
      // Unknown command — friendly nudge toward /help.
      if (command.raw.startsWith("/")) {
        await provider.sendMessage(chatId, `Unknown command. Send /help to see what I can do.`);
      }
      return { ok: true, message: "Unknown command ignored." };
    }
  }
}

/**
 * Handle the /start CODE command: find the user by code, verify expiry,
 * check the chat isn't already linked to another user, then create the link.
 */
async function handleLinkCommand(
  chatId: string,
  code: string,
  provider: import("@/lib/telegram/provider").TelegramProvider,
  username: string | null,
): Promise<TelegramActionResult> {
  const user = await db.user.findFirst({
    where: { telegramLinkCode: code },
    select: {
      id: true,
      email: true,
      telegramLinkCodeExpiresAt: true,
    },
  });
  if (!user) {
    await provider.sendMessage(
      chatId,
      "❌ Invalid or expired code. Generate a fresh one in Settings → Telegram and try again.",
    );
    return { ok: false, message: "Invalid code." };
  }
  if (user.telegramLinkCodeExpiresAt && user.telegramLinkCodeExpiresAt < new Date()) {
    await provider.sendMessage(
      chatId,
      "❌ This code has expired. Generate a fresh one in Settings → Telegram.",
    );
    return { ok: false, message: "Code expired." };
  }

  // Chat already linked to another user?
  const existingByChat = await db.telegramLink.findUnique({ where: { chatId } });
  if (existingByChat && existingByChat.userId !== user.id) {
    await provider.sendMessage(
      chatId,
      "❌ This Telegram chat is already linked to another RiskGuard account. Unlink it there first.",
    );
    return { ok: false, message: "Chat already in use." };
  }

  // Upsert the link (re-linking the same user replaces the chat).
  await db.telegramLink.upsert({
    where: { userId: user.id },
    create: { userId: user.id, chatId, verifiedAt: new Date(), username },
    update: { chatId, verifiedAt: new Date(), username },
  });
  // Clear the pending code.
  await db.user.update({
    where: { id: user.id },
    data: { telegramLinkCode: null, telegramLinkCodeExpiresAt: null },
  });
  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "TELEGRAM_LINKED",
      entity: "TelegramLink",
      entityId: user.id,
      meta: { chatId },
    },
  });
  await provider.sendMessage(
    chatId,
    `✅ RiskGuard account linked!\n\nYou'll now receive discipline alerts. Send /help to see the commands, /stop to pause.`,
  );
  return { ok: true, message: "Account linked." };
}

// ─── 6. buildStatusMessageAction ─────────────────────────────────────────────

/**
 * Build the /status response: balance, today's P/L, risk meter summary.
 * Called by the webhook handler. System-level (no requireUser — the
 * webhook authenticates via the Telegram chat link).
 */
export async function buildStatusMessageAction(userId: string): Promise<string> {
  const account = await db.tradingAccount.findFirst({
    where: { userId, isArchived: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, currency: true, currentBalance: true },
  });
  if (!account) {
    return "No trading account found. Add one in the RiskGuard app.";
  }

  // Today's P/L in the user's TZ.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone || "UTC";
  const todayKey = dayKeyInTz(new Date(), tz);
  const [y, m, d] = todayKey.split("-").map(Number);
  const dayStartUtc = new Date(Date.UTC(y, m - 1, d));

  const todayTrades = await db.trade.findMany({
    where: {
      userId,
      tradingAccountId: account.id,
      result: { in: ["WIN", "LOSS", "TIE"] },
      openedAt: { gte: dayStartUtc },
    },
    select: { profitLoss: true, result: true },
  });
  const todayPL = todayTrades.reduce(
    (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const wins = todayTrades.filter((t) => t.result === "WIN").length;

  // Risk meter: the active risk profile's daily loss usage.
  const profile =
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: account.id },
    })) ??
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: null },
      orderBy: { createdAt: "desc" },
    }));

  const balance = new Decimal(account.currentBalance.toString());
  const dailyLossSoFar = todayPL.lt(0) ? todayPL.abs() : new Decimal(0);
  let riskLine = "Risk: no limits configured.";
  if (profile?.maxDailyLossPercent) {
    const cap = balance.mul(new Decimal(profile.maxDailyLossPercent.toString())).div(100);
    const usedPct = cap.gt(0) ? dailyLossSoFar.mul(100).div(cap).toNumber() : 0;
    riskLine = `Risk meter: ${usedPct.toFixed(0)}% of daily loss limit used.`;
  }

  const sign = todayPL.gte(0) ? "+" : "−";
  return (
    `<b>RiskGuard status</b>\n\n` +
    `Account: ${account.name}\n` +
    `Balance: ${account.currency} ${balance.toFixed(2)}\n` +
    `Today's P/L: ${sign}${todayPL.abs().toFixed(2)} (${wins}W/${todayTrades.length - wins}L)\n` +
    riskLine +
    `\n\n<i>Discipline tool — not financial advice.</i>`
  );
}

// ─── 7. sendDailySummariesAction ─────────────────────────────────────────────

/**
 * Cron-friendly: send the daily summary to every user whose
 * `telegramDailySummaryTime` matches the current time (within the hour
 * bucket) in their TZ. Called every 15 minutes by the cron.
 *
 * The summary includes: balance, today's P/L, discipline score, streak.
 */
export async function sendDailySummariesAction(): Promise<
  TelegramActionResult & { sentCount?: number; scannedCount?: number }
> {
  const users = await db.user.findMany({
    where: { isOnboarded: true },
    select: {
      id: true,
      timezone: true,
      telegramDailySummaryTime: true,
      telegramAlertsEnabled: true,
      telegramAlertsPaused: true,
    },
  });

  let sent = 0;
  for (const user of users) {
    try {
      if (!user.telegramDailySummaryTime) continue;
      if (!user.telegramAlertsEnabled || user.telegramAlertsPaused) continue;

      // Match the current time to the user's chosen time within the current
      // 15-minute bucket (the cron runs every 15 min).
      const tz = user.timezone || "UTC";
      const now = new Date();
      const nowKey = dayKeyInTz(now, tz);
      const [ny, nm, nd] = nowKey.split("-").map(Number);
      // Compute "now" minutes-of-day in the user's TZ.
      const nowMinutes = nowMinutesInTz(now, tz);
      const [hh, mm] = user.telegramDailySummaryTime.split(":").map(Number);
      const targetMinutes = hh * 60 + mm;
      // Fire when nowMinutes is within [target, target+15).
      if (nowMinutes < targetMinutes || nowMinutes >= targetMinutes + 15) continue;

      // Build the summary.
      const account = await db.tradingAccount.findFirst({
        where: { userId: user.id, isArchived: false },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, currency: true, currentBalance: true },
      });
      if (!account) continue;
      const [y, m, d] = nowKey.split("-").map(Number);
      const dayStartUtc = new Date(Date.UTC(y, m - 1, d));
      const todayTrades = await db.trade.findMany({
        where: {
          userId: user.id,
          tradingAccountId: account.id,
          result: { in: ["WIN", "LOSS", "TIE"] },
          openedAt: { gte: dayStartUtc },
        },
        select: { profitLoss: true, result: true },
      });
      const todayPL = todayTrades.reduce(
        (acc, t) => acc.plus(new Decimal(t.profitLoss.toString())),
        new Decimal(0),
      );
      const todayScore = await db.dailyScore.findUnique({
        where: { userId_date: { userId: user.id, date: nowKey } },
        select: { score: true, isRestDay: true },
      });

      const balance = new Decimal(account.currentBalance.toString());
      const sign = todayPL.gte(0) ? "+" : "−";
      const scoreLine =
        todayScore == null
          ? "Discipline score: not yet computed."
          : `Discipline score: ${Number(todayScore.score.toString())}${todayScore.isRestDay ? " (rest day)" : ""}`;

      const text =
        `<b>RiskGuard daily summary — ${nowKey}</b>\n\n` +
        `Account: ${account.name}\n` +
        `Balance: ${account.currency} ${balance.toFixed(2)}\n` +
        `Today's P/L: ${sign}${todayPL.abs().toFixed(2)} (${todayTrades.length} trade${todayTrades.length === 1 ? "" : "s"})\n` +
        scoreLine +
        `\n\n<i>Discipline tool — not financial advice.</i>`;

      const res = await sendTelegramAlertAction(user.id, "DAILY_SUMMARY", `Daily summary`, text);
      if (res.delivered) sent++;
    } catch {
      // Per-user failure — skip + continue.
    }
  }

  return {
    ok: true,
    message: `Daily summary sweep: ${sent} sent of ${users.length} users.`,
    sentCount: sent,
    scannedCount: users.length,
  };
}

// ─── TZ helper ───────────────────────────────────────────────────────────────

/**
 * Compute the current minutes-of-day (0–1439) in the given TZ.
 */
function nowMinutesInTz(d: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const hRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
    const mRaw = parts.find((p) => p.type === "minute")?.value ?? "0";
    const h = hRaw === "24" ? 0 : Number(hRaw);
    return h * 60 + Number(mRaw);
  } catch {
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

// Avoid unused-import lint warnings for helpers used only in types.
void shiftDayKey;
