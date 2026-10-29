"use client";

/**
 * Phase 28 — `useMarketStream` hook.
 *
 * Subscribes to `GET /api/market/stream` (SSE). Behaviour per spec:
 *   - auto-reconnect on drop (exponential backoff, capped);
 *   - if SSE keeps failing, FALL BACK to 30-second polling via the
 *     `getMarketSnapshotAction` server action;
 *   - cleans up the EventSource + timers on unmount (no connection leaks).
 *
 * Returns the latest snapshot plus a status the UI uses to grey out ratings
 * during an outage.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getMarketSnapshotAction } from "@/server/actions/market-live";
import type { MarketSnapshot } from "@/server/lib/market-snapshot";

const POLL_FALLBACK_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** Reconnect attempts before degrading to the polling fallback. */
const MAX_SSE_ATTEMPTS = 3;

export type MarketStreamStatus = "connecting" | "live" | "polling" | "offline";

export function useMarketStream(initial: MarketSnapshot | null) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(initial);
  const [status, setStatus] = useState<MarketStreamStatus>("connecting");

  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const next = await getMarketSnapshotAction();
      setSnapshot(next);
      setStatus("live");
    } catch {
      setStatus("offline");
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return; // already polling
    setStatus("polling");
    void pollOnce();
    pollTimerRef.current = setInterval(() => void pollOnce(), POLL_FALLBACK_MS);
  }, [pollOnce]);

  useEffect(() => {
    stoppedRef.current = false;

    // Hoisted declaration: `connect` can re-schedule ITSELF on reconnect
    // without hitting the temporal-dead-zone (a `const connect = useCallback`
    // would reference itself before its own declaration).
    function connect() {
      if (stoppedRef.current) return;
      try {
        const es = new EventSource("/api/market/stream");
        esRef.current = es;

        es.onopen = () => {
          attemptsRef.current = 0;
          setStatus("live");
          stopPolling(); // SSE recovered — stop the fallback poller
        };

        es.onmessage = (ev) => {
          if (!ev.data) return;
          try {
            setSnapshot(JSON.parse(ev.data) as MarketSnapshot);
          } catch {
            /* ignore malformed frame */
          }
        };

        es.onerror = () => {
          es.close();
          esRef.current = null;
          if (stoppedRef.current) return;
          attemptsRef.current += 1;
          // After a few failed reconnects, degrade to polling (spec fallback).
          if (attemptsRef.current >= MAX_SSE_ATTEMPTS) {
            startPolling();
            return;
          }
          const backoff = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
          retryTimerRef.current = setTimeout(connect, backoff);
        };
      } catch {
        startPolling();
      }
    }

    connect();

    return () => {
      stoppedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      stopPolling();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
  }, [startPolling, stopPolling]);

  return { snapshot, status, refresh: pollOnce };
}
