"use client";

/**
 * Phase 28 — Mini M5 price chart for the pair-detail drawer (Recharts).
 *
 * A lightweight close-price line with a range label — enough to give context
 * without pulling a full charting library into the drawer.
 */
import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { getPairCandlesAction, type PairCandle } from "@/server/actions/market-candles";

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function MiniM5Chart({ symbol }: { symbol: string }) {
  // State is keyed by symbol so a pair switch re-renders correctly WITHOUT a
  // synchronous setState inside the effect (react-hooks/set-state-in-effect).
  const [state, setState] = useState<{
    symbol: string;
    rows: PairCandle[] | null;
    error: boolean;
  }>({ symbol, rows: null, error: false });

  useEffect(() => {
    let cancelled = false;
    getPairCandlesAction({ symbol, limit: 200 })
      .then((rows) => {
        if (!cancelled) setState({ symbol, rows, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ symbol, rows: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const stale = state.symbol !== symbol;
  const candles = stale ? null : state.rows;
  const error = !stale && state.error;

  if (error) {
    return <p className="text-sm text-muted-foreground">Price history unavailable.</p>;
  }
  if (!candles || candles.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading price history…</p>;
  }

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const data = candles.map((c) => ({ t: fmtTime(c.time), price: c.close }));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>M5 close · last {candles.length}</span>
        <span className={changePct >= 0 ? "text-emerald-500" : "text-red-500"}>
          {changePct >= 0 ? "+" : ""}
          {changePct.toFixed(3)}%
        </span>
      </div>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10 }} width={50} />
            <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => [String(v), "Close"]} />
            <Area
              type="monotone"
              dataKey="price"
              stroke="var(--primary)"
              fill="var(--primary)"
              fillOpacity={0.12}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
