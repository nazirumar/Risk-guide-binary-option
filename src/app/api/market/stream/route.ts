/**
 * Phase 28 — SSE endpoint: `GET /api/market/stream`.
 *
 * (PROJECT_RULES.md rule #3: market rows are global, but the stream still
 * requires auth — `requireUser()` runs BEFORE any bytes are flushed, so an
 * unauthenticated request gets a clean 302/401 instead of a hanging stream.)
 *
 * - Content-Type: text/event-stream, no-cache, no-transform.
 * - Auth first, then subscribe to the shared hub (one DB poll for ALL clients).
 * - Heartbeat comment (`: hb`) every 20s keeps proxies + the browser from
 *   idling the connection out, and gives the client a liveness signal.
 * - Cleanup on disconnect: `req.signal` abort → unsubscribe → close. This is
 *   what stops connection leaks.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/server/lib/require-user";
import { subscribeToMarketStream } from "@/server/lib/market-stream";

/** Heartbeat interval (spec: every 20 seconds). */
const HEARTBEAT_MS = 20_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  // Vercel Serverless cannot hold long-lived SSE connections.
  // Fall back to polling (use-market-stream.ts already handles this).
  if (process.env.VERCEL) {
    try {
      await requireUser();
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "sse_disabled_on_serverless", message: "Use snapshot polling" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    // Auth BEFORE creating the stream — a throw here is still a normal response.
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          cleanup(); // controller already closed by the runtime
        }
      };

      // "connected" frame so the client can distinguish "open" from "data".
      send(`: connected\n\n`);

      unsubscribe = subscribeToMarketStream({ send });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Nagle-ish buffering on some proxies.
      "X-Accel-Buffering": "no",
    },
  });
}
