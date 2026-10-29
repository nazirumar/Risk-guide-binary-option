/**
 * Phase 28 — SSE load test: 200 simulated clients.
 *
 * Verifies under concurrency (spec acceptance: "load-test with 200 simulated
 * clients"):
 *   1. Login via the NextAuth credentials callback (API-level, no browser) and
 *      reuse the session cookie for 200 concurrent raw `fetch` readers.
 *   2. ≥ 95% of clients receive at least one snapshot frame within 17 s of
 *      THEIR OWN connect (one shared hub poll must serve them all — see the
 *      market-stream unit test). Connections are opened in staggered waves:
 *      200 simultaneous SYNs overflow the dev server's accept queue on Windows
 *      (measured: ~6–11 s median handshake + ECONNREFUSED storms), which is a
 *      harness artifact, not a hub property.
 *   3. After aborting all 200 connections, a fresh single client still receives
 *      a frame promptly → the server wasn't wedged by the storm.
 *
 * Runs against the Playwright-managed dev server (same webServer config as the
 * other e2e specs). Uses its own unique user so it can't collide with other
 * specs.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const db = new PrismaClient();

const CLIENTS = 200;
/** Open this many connections at once, then wait STAGGER_MS before the next wave. */
const CONNECT_WAVE = 20;
const CONNECT_STAGGER_MS = 400;
/** Per-client read window from ITS OWN connect: ≥ one 15 s hub tick + margin. */
const READ_MS_AFTER_CONNECT = 17_000;
const email = `e2e-load+${randomBytes(4).toString("hex")}@example.com`;
const password = "TestPass123!";

/** Perform the NextAuth credentials login on an API request context. */
async function loginViaApi(request: APIRequestContext): Promise<string> {
  const csrfRes = await request.get("/api/auth/csrf");
  expect(csrfRes.ok()).toBeTruthy();
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const loginRes = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", remember: "false" },
    maxRedirects: 0,
  });
  expect([200, 302, 303]).toContain(loginRes.status());

  const state = await request.storageState();
  // next-auth v4 (http://localhost) → "next-auth.session-token"; secure
  // contexts → "__Secure-next-auth.session-token" (v5 names kept as fallback).
  const session =
    state.cookies.find((c) => c.name === "next-auth.session-token") ??
    state.cookies.find((c) => c.name === "__Secure-next-auth.session-token") ??
    state.cookies.find((c) => c.name === "authjs.session-token") ??
    state.cookies.find((c) => c.name === "__Secure-authjs.session-token");
  expect(session, "session cookie after login").toBeTruthy();
  return `${session!.name}=${session!.value}`;
}

test.beforeAll(async () => {
  // Same Neon pooler wake-up guard as market-dashboard.spec.ts.
  let connected = false;
  for (let attempt = 1; attempt <= 4 && !connected; attempt++) {
    try {
      await db.$connect();
      connected = true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!connected) throw new Error("Could not connect to the database");

  await db.user.deleteMany({ where: { email } });
  await db.user.create({
    data: {
      email,
      name: "LOAD E2E",
      passwordHash: await argon2.hash(password),
      emailVerified: new Date(),
      isOnboarded: true,
      timezone: "UTC",
    },
  });
});

test.afterAll(async () => {
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

test("200 concurrent SSE clients all receive snapshots and disconnect cleanly", async ({
  request,
}) => {
  test.setTimeout(240_000);
  // Pre-compile the stream route (next dev compiles on first hit) so the
  // concurrent connects aren't stalled behind a cold compile.
  await fetch("http://localhost:3000/api/market/stream").catch(() => {});
  const cookie = await loginViaApi(request);

  const received = new Array(CLIENTS).fill(0);
  const connectMs = new Array(CLIENTS).fill(-1);
  const firstDataMs = new Array(CLIENTS).fill(-1);
  const failed: number[] = [];
  const aborts: Array<() => void> = [];
  const startedAt = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, i) => {
      // Staggered waves: a single 200-connection burst overflows the dev
      // server's accept queue on Windows (ECONNREFUSED storms + ~10 s queue).
      await sleep(Math.floor(i / CONNECT_WAVE) * CONNECT_STAGGER_MS);
      const ac = new AbortController();
      aborts.push(() => ac.abort());

      // One retry: transient refusals during a wave are a harness artifact.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
          res = await fetch("http://localhost:3000/api/market/stream", {
            headers: { cookie, accept: "text/event-stream" },
            signal: ac.signal,
          });
        } catch {
          await sleep(2_000);
        }
      }
      if (!res || !res.ok || !res.body) {
        failed.push(i);
        ac.abort();
        return;
      }
      connectMs[i] = Date.now() - startedAt;

      // Read until 17 s after THIS client connected (≥ one full hub tick), so
      // slow handshakes don't eat the client's measurement window.
      const deadline = Date.now() + READ_MS_AFTER_CONNECT;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          if (decoder.decode(value).includes("data:")) {
            received[i]++;
            if (firstDataMs[i] < 0) firstDataMs[i] = Date.now() - startedAt;
          }
        }
      } catch {
        /* abort/teardown — frame counts above stand */
      }
      ac.abort();
    }),
  );

  const withData = received.filter((n) => n > 0).length;
  const misses = received.map((n, i) => i).filter((i) => received[i] === 0);
  const missConnectSorted = misses.map((i) => connectMs[i]).sort((a, b) => a - b);
  const hitConnectSorted = connectMs.filter((m) => m >= 0).sort((a, b) => a - b);
  const pct = (arr: number[], p: number) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length * p) | 0))] : -1;
  console.log(
    `[load] opened=${CLIENTS - failed.length} failed=${failed.length} withSnapshot=${withData}`,
  );
  console.log(
    `[load] connectMs p50=${pct(hitConnectSorted, 0.5)} p95=${pct(hitConnectSorted, 0.95)} max=${hitConnectSorted.at(-1)}`,
  );
  console.log(
    `[load] firstDataMs-after-connect p50=${pct(
      firstDataMs.filter((m) => m >= 0).sort((a, b) => a - b),
      0.5,
    )} ` +
      `max=${firstDataMs
        .filter((m) => m >= 0)
        .sort((a, b) => a - b)
        .at(-1)}`,
  );
  console.log(
    `[load] misses=${misses.length} connectMs p50=${pct(missConnectSorted, 0.5)} max=${missConnectSorted.at(-1)}`,
  );
  expect(failed.length).toBe(0);
  // ≥95% must have received at least one snapshot frame.
  expect(withData).toBeGreaterThanOrEqual(Math.floor(CLIENTS * 0.95));

  // Let the hub reap every aborted connection, then verify the server still
  // serves a fresh SSE client promptly (no wedge / no leaked poller).
  await new Promise((r) => setTimeout(r, 3_000));
  const ac = new AbortController();
  const res = await fetch("http://localhost:3000/api/market/stream", {
    headers: { cookie, accept: "text/event-stream" },
    signal: ac.signal,
  });
  expect(res.ok).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let gotFrame = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !gotFrame) {
    const { done, value } = await reader.read();
    if (done) break;
    if (decoder.decode(value).includes("data:")) gotFrame = true;
  }
  ac.abort();
  expect(gotFrame, "fresh client after the storm still gets a snapshot").toBeTruthy();
});
