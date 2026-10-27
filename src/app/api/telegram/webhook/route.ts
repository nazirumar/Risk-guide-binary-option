/**
 * POST /api/telegram/webhook — Telegram bot webhook receiver.
 *
 * Setup (one-time, via the Telegram Bot API setWebhook call):
 *   ```bash
 *   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
 *     -d "url=https://yourdomain.com/api/telegram/webhook" \
 *     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
 *   ```
 *
 * Security: Telegram includes the secret_token in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every update POST. We verify
 * it (timing-safe) BEFORE processing — requests without the correct header
 * are rejected with 401.
 *
 * NEVER call this route from the app UI — it's a Telegram-only endpoint.
 */
import { NextResponse } from "next/server";
import { getTelegramProvider, type TelegramUpdate } from "@/lib/telegram/provider";
import { handleTelegramWebhookAction } from "@/server/actions/telegram";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  const provider = getTelegramProvider();
  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");

  // Verify the webhook signature (timing-safe) BEFORE parsing the body.
  if (!provider.verifyWebhookSignature(secretHeader)) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse the update. Telegram always sends a valid JSON update object —
  // but we're defensive (a malformed body should 400, not 500).
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new NextResponse(JSON.stringify({ error: "Malformed body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await handleTelegramWebhookAction(update);
    // Telegram expects a 200 response (any body) — non-200 responses cause
    // Telegram to retry the update.
    return new NextResponse(JSON.stringify({ ok: true, message: res.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // Log + return 200 so Telegram doesn't retry-loop. The error is logged
    // server-side for debugging.
    console.error("[TelegramWebhook] handler error:", e);
    return new NextResponse(JSON.stringify({ ok: true, handled: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
