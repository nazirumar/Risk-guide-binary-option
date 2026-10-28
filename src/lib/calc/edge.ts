export type EdgeGroup = { key: string; trades: number; wins: number; winRate: number; expectancy: number; totalPnl: number; reliability: "INSUFFICIENT" | "LOW" | "OK" };

export function groupEdge(trades: Array<{ pair: string; session: string; rating: string | null; pnl: number; win: boolean }>, keyFn: (t: typeof trades[number]) => string): EdgeGroup[] {
  const map = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of trades) {
    const k = keyFn(t);
    const g = map.get(k) ?? { trades: 0, wins: 0, pnl: 0 };
    g.trades += 1;
    if (t.win) g.wins += 1;
    g.pnl += t.pnl;
    map.set(k, g);
  }
  return Array.from(map.entries()).map(([key, g]) => ({
    key,
    trades: g.trades,
    wins: g.wins,
    winRate: g.trades ? g.wins / g.trades : 0,
    expectancy: g.trades ? g.pnl / g.trades : 0,
    totalPnl: g.pnl,
    reliability: g.trades < 30 ? "INSUFFICIENT" : g.trades < 60 ? "LOW" : "OK",
  }));
}
