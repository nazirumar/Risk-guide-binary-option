/**
 * Phase 28 — SSE broadcast hub (server-only).
 *
 * (PROJECT_RULES.md rule #11: this payload drives descriptive UI copy only.)
 *
 * Design: ONE ref-counted poller serves EVERY connected client. 200 simulated
 * clients → still exactly one DB read per tick and one `setInterval`, not 200.
 * This is what keeps the dashboard under 1.5s and stops SSE from leaking
 * connections: the timer stops itself when the last subscriber unsubscribes.
 *
 * Payload is cached per tick and re-sent verbatim to late joiners, so a burst
 * of reconnects never triggers a stampede of DB reads.
 */
import { buildMarketSnapshot, type MarketSnapshot } from "@/server/lib/market-snapshot";

export type MarketStreamSubscriber = {
  /** Send a raw SSE data payload (already formatted) to this client. */
  send: (payload: string) => void;
};

/** How often the shared snapshot is refreshed from the DB. */
const POLL_INTERVAL_MS = 15_000;

const subscribers = new Set<MarketStreamSubscriber>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let cachedPayload: string | null = null;
let lastFetchAt = 0;
/** Serializes overlapping ticks so a slow DB read can't stack up queries. */
let inFlight: Promise<void> | null = null;

function serialize(snapshot: MarketSnapshot): string {
  return `data: ${JSON.stringify(snapshot)}\n\n`;
}

async function refresh(): Promise<void> {
  try {
    const snapshot = await buildMarketSnapshot();
    cachedPayload = serialize(snapshot);
    lastFetchAt = Date.now();
    for (const s of subscribers) {
      try {
        s.send(cachedPayload);
      } catch {
        subscribers.delete(s); // dead socket — drop it (no leak)
      }
    }
  } catch (err) {
    // Never crash the poller; the previous cached payload keeps serving.
    console.error("[market-stream] snapshot refresh failed", err);
  }
}

function ensurePolling(): void {
  if (pollTimer) return;
  const tick = () => {
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  void tick(); // immediate snapshot for the first subscriber
  pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Don't hold the process open just for market streaming.
  pollTimer.unref?.();
}

function maybeStopPolling(): void {
  if (subscribers.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  cachedPayload = null;
  lastFetchAt = 0;
}

/**
 * Subscribe to the shared market stream. Returns an unsubscribe function —
 * ALWAYS call it in a `finally`/abort handler so connections are cleaned up.
 */
export function subscribeToMarketStream(subscriber: MarketStreamSubscriber): () => void {
  subscribers.add(subscriber);
  ensurePolling();

  if (cachedPayload && Date.now() - lastFetchAt < POLL_INTERVAL_MS) {
    try {
      subscriber.send(cachedPayload);
    } catch {
      /* ignore — the caller's abort handler will unsubscribe */
    }
  }

  return () => {
    subscribers.delete(subscriber);
    maybeStopPolling();
  };
}

/** Test/ops hook: current live subscriber count. */
export function marketStreamSubscriberCount(): number {
  return subscribers.size;
}
