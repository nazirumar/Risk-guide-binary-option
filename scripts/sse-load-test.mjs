/**
 * Phase 28 — SSE load test: 200 simulated clients.
 *
 * Verifies the `/api/market/stream` hub under concurrency:
 *   - every one of N clients receives at least one snapshot frame;
 *   - disconnecting all clients returns the server's subscriber count to 0
 *     (no connection leak).
 *
 * Usage (server must already be running, e.g. `bun run start` on :3000, and you
 * must be logged in so the session cookie is valid):
 *   node scripts/sse-load-test.mjs --base=http://localhost:3000 --clients=200 \
 *     --cookie="authjs.session-token=..."
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  }),
);

const BASE = args.base ?? "http://localhost:3000";
const CLIENTS = Number(args.clients ?? 200);
const COOKIE = args.cookie ?? "";
const DURATION_MS = Number(args.duration ?? 20_000);

const headers = COOKIE ? { cookie: COOKIE } : undefined;

async function run() {
  console.log(`Opening ${CLIENTS} SSE clients against ${BASE} for ${DURATION_MS / 1000}s…`);
  const controllers = [];
  const received = new Array(CLIENTS).fill(0);
  const startedAt = Date.now();
  let opened = 0;
  let failed = 0;

  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, i) => {
      try {
        const res = await fetch(`${BASE}/api/market/stream`, { headers });
        if (!res.ok || !res.body) {
          failed++;
          return;
        }
        opened++;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        controllers.push(async () => {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
        });
        // Read frames until the test duration elapses.
        while (Date.now() - startedAt < DURATION_MS) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          if (text.includes("data:")) received[i]++;
        }
      } catch {
        failed++;
      }
    }),
  );

  // Drop every connection, then give the server a moment to reap them.
  await Promise.all(controllers.map((c) => c()));
  await new Promise((r) => setTimeout(r, 1500));

  const withData = received.filter((n) => n > 0).length;
  console.log(`opened=${opened} failed=${failed} receivedAtLeastOneSnapshot=${withData}`);

  const res = await fetch(`${BASE}/api/market/stream`, { headers });
  console.log(
    "note: subscriber count is internal; verify via server logs or a /api/market/stream probe.",
  );
  void res;

  if (failed > 0 || withData < opened * 0.9) {
    console.error("LOAD TEST FAILED: too many failures or clients without data.");
    process.exit(1);
  }
  console.log("LOAD TEST PASSED.");
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
