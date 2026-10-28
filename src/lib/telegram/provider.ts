/**
 * Pure Telegram provider interface for Phase 23 — Telegram Alerts.
 *
 * (PROJECT_RULES.md rule #2: pure helpers live in /src/lib. The provider
 * interface is swappable so tests can mock it and prod can swap the
 * transport without touching call sites.)
 *
 * The provider handles two concerns:
 *   1. `sendMessage(chatId, text)` — deliver an alert to a Telegram chat.
 *   2. `verifyWebhookSignature(header, body)` — timing-safe check of the
 *      `X-Telegram-Bot-Api-Secret-Token` header against the configured
 *      secret (TELEGRAM_WEBHOOK_SECRET env var).
 *
 * Production wiring:
 *   - `RealTelegramProvider`: uses the Telegram Bot API via fetch with
 *     TELEGRAM_BOT_TOKEN. Not enabled unless the env var is set.
 *   - `ConsoleTelegramProvider`: dev fallback — logs the message to the
 *     console instead of sending. Useful in dev + CI without a real bot.
 *
 * Webhook signature verification per Telegram docs:
 *   When you set a webhook with a `secret_token` parameter, Telegram
 *   includes that token in the `X-Telegram-Bot-Api-Secret-Token` header
 *   of every update POST. We compare it (timing-safe) to the env var.
 */

import { createHash, timingSafeEqual } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
};

// ─── Interface ───────────────────────────────────────────────────────────────

export interface TelegramProvider {
  /** Unique identifier — used for logging/debug. */
  readonly name: string;

  /**
   * Send a message to a Telegram chat. Returns the message ID on success,
   * or throws on failure (caller decides how to handle).
   */
  sendMessage(chatId: string, text: string): Promise<{ messageId?: number }>;

  /**
   * Verify the webhook secret-token header (timing-safe). Returns true iff
   * the header matches the configured secret.
   */
  verifyWebhookSignature(headerValue: string | null): boolean;
}

// ─── Console provider (dev fallback) ────────────────────────────────────────

/**
 * Dev-only Telegram provider — logs messages to the console instead of
 * sending them. Webhook signature verification still works (the secret
 * comes from TELEGRAM_WEBHOOK_SECRET or defaults to a dev-only value).
 */
export class ConsoleTelegramProvider implements TelegramProvider {
  readonly name = "ConsoleTelegram";
  private readonly webhookSecret: string;

  constructor(webhookSecret?: string) {
    this.webhookSecret = webhookSecret ?? "dev-telegram-webhook-secret";
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId?: number }> {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `\n────────── TELEGRAM (dev console fallback) ──────────\n` +
          `To chat: ${chatId}\n` +
          `Message:\n${text}\n` +
          `─────────────────────────────────────────────────────\n`,
      );
    }
    return { messageId: Math.floor(Math.random() * 1_000_000) };
  }

  verifyWebhookSignature(headerValue: string | null): boolean {
    return timingSafeCompare(headerValue, this.webhookSecret);
  }
}

// ─── Real provider (Telegram Bot API) ────────────────────────────────────────

/**
 * Real Telegram provider using the Bot API. Requires TELEGRAM_BOT_TOKEN.
 * The webhook secret comes from TELEGRAM_WEBHOOK_SECRET (required in prod).
 */
export class RealTelegramProvider implements TelegramProvider {
  readonly name = "TelegramBot";
  private readonly botToken: string;
  private readonly webhookSecret: string;

  constructor(botToken: string, webhookSecret?: string) {
    this.botToken = botToken;
    this.webhookSecret = webhookSecret ?? "";
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId?: number }> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { result?: { message_id?: number } };
    return { messageId: data.result?.message_id };
  }

  verifyWebhookSignature(headerValue: string | null): boolean {
    if (!this.webhookSecret) return true;
    return timingSafeCompare(headerValue, this.webhookSecret);
  }
}

/**
 * Timing-safe string comparison. Hashes both strings to a fixed length
 * first (so length differences don't leak), then uses `timingSafeEqual`.
 * Returns false when either input is null/undefined/empty.
 */
export function timingSafeCompare(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _provider: TelegramProvider | null = null;

/**
 * Resolve the configured Telegram provider:
 *   1. Test-registered provider via `setTelegramProvider` (highest priority).
 *   2. `RealTelegramProvider` when TELEGRAM_BOT_TOKEN is set.
 *   3. `ConsoleTelegramProvider` fallback (dev default).
 */
export function getTelegramProvider(): TelegramProvider {
  if (_provider) return _provider;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (botToken && botToken.length > 0) {
    _provider = new RealTelegramProvider(botToken, webhookSecret);
  } else {
    _provider = new ConsoleTelegramProvider(webhookSecret);
  }
  return _provider;
}

/**
 * Test-only: register a custom provider. Resets the singleton.
 */
export function setTelegramProvider(provider: TelegramProvider | null): void {
  _provider = provider;
}

// ─── Telegram command parsing (pure) ────────────────────────────────────────

export type TelegramCommand =
  | { kind: "start"; code?: string }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

/**
 * Parse a Telegram message text into a command. The /start command may
 * carry a link code ("/start RG-XXXX-XXXX") or nothing ("/start" — resume
 * paused alerts).
 *
 * Examples:
 *   parseTelegramCommand("/start RG-4F2A-9C1B") → { kind: "start", code: "RG-4F2A-9C1B" }
 *   parseTelegramCommand("/start")              → { kind: "start", code: undefined }
 *   parseTelegramCommand("/status")             → { kind: "status" }
 *   parseTelegramCommand("/stop")               → { kind: "stop" }
 *   parseTelegramCommand("/help")               → { kind: "help" }
 *   parseTelegramCommand("hello")               → { kind: "unknown", raw: "hello" }
 */
export function parseTelegramCommand(text: string | undefined): TelegramCommand {
  if (!text || !text.startsWith("/")) {
    return { kind: "unknown", raw: text ?? "" };
  }
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase().split("@")[0]; // strip "/status@BotName" suffix
  switch (cmd) {
    case "/start":
      return { kind: "start", code: parts[1]?.toUpperCase() || undefined };
    case "/status":
      return { kind: "status" };
    case "/stop":
      return { kind: "stop" };
    case "/help":
      return { kind: "help" };
    default:
      return { kind: "unknown", raw: text };
  }
}

/**
 * Generate a one-time link code in the format "RG-XXXX-XXXX" (8 alphanumeric
 * chars, uppercase, excluding ambiguous chars 0/O/1/I). 15-minute expiry is
 * enforced by the caller.
 */
export function generateLinkCode(): string {
  // Excluding ambiguous chars: 0/O, 1/I/L.
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => charset[Math.floor(Math.random() * charset.length)];
  const part1 = `${pick()}${pick()}${pick()}${pick()}`;
  const part2 = `${pick()}${pick()}${pick()}${pick()}`;
  return `RG-${part1}-${part2}`;
}
