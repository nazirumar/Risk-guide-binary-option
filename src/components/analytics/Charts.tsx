"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

/**
 * EquityCurveChart — Recharts AreaChart showing the account's equity curve.
 */
export function EquityCurveChart({
  data,
  height = 300,
}: {
  data: { date: string; balance: number }[];
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No data — add some trades to see your equity curve.
      </div>
    );
  }
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={formatted} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <defs>
            <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--profit)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--profit)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            interval="preserveStartEnd"
            minTickGap={30}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
            width={50}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, "Balance"]}
            labelFormatter={(label) => `Date: ${label}`}
          />
          <Area
            type="monotone"
            dataKey="balance"
            stroke="var(--profit)"
            strokeWidth={2}
            fill="url(#equityGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * DrawdownChart — shows the drawdown (peak-to-trough drop) over time.
 * Uses loss-red for the area fill.
 */
export function DrawdownChart({
  data,
  height = 200,
}: {
  data: { date: string; drawdown: number }[];
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No drawdown data.
      </div>
    );
  }
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={formatted} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <defs>
            <linearGradient id="ddGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--loss)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--loss)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            interval="preserveStartEnd"
            minTickGap={30}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => `-$${Math.abs(v).toFixed(0)}`}
            width={60}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            formatter={(value: number) => [`-$${Math.abs(value).toFixed(2)}`, "Drawdown"]}
            labelFormatter={(label) => `Date: ${label}`}
          />
          <Area
            type="monotone"
            dataKey="drawdown"
            stroke="var(--loss)"
            strokeWidth={2}
            fill="url(#ddGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * WinRateBreakdown — generic horizontal bar chart for "win rate by X" breakdowns.
 * Each bar is colored green (good) / amber (marginal) / red (bad) based on win rate.
 */
export function WinRateBreakdown({
  title,
  data,
}: {
  title: string;
  data: {
    key: string;
    count: number;
    winRate: number;
    netProfit: number;
    expectancyPerTrade: number;
  }[];
}) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-2">{title}</h3>
        <p className="text-xs text-muted-foreground">No data for this breakdown.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <div className="space-y-2">
        {data.slice(0, 10).map((item) => {
          const wr = item.winRate * 100;
          const color = wr >= 55 ? "bg-profit" : wr >= 45 ? "bg-warning" : "bg-loss";
          return (
            <div key={item.key} className="flex items-center gap-2 text-xs">
              <span className="w-20 truncate font-mono">{item.key}</span>
              <div className="flex-1 h-5 rounded-sm bg-muted overflow-hidden">
                <div
                  className={`h-full ${color} flex items-center justify-end px-1`}
                  style={{ width: `${Math.max(5, wr)}%` }}
                >
                  <span className="text-[10px] font-medium text-white">{wr.toFixed(0)}%</span>
                </div>
              </div>
              <span className="w-16 text-right tabular-nums text-muted-foreground">
                {item.netProfit >= 0 ? "+" : ""}
                {item.netProfit.toFixed(0)}
              </span>
              <span className="w-10 text-right tabular-nums text-muted-foreground">
                {item.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * InsightsPanel — renders the rule-based plain-language findings from the
 * analytics engine.
 */
export function InsightsPanel({ insights }: { insights: string[] }) {
  if (insights.length === 0) {
    return null;
  }
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
      <h3 className="text-sm font-semibold flex items-center gap-1.5">
        <span className="text-amber-500">⚡</span>
        Insights
      </h3>
      <ul className="space-y-2">
        {insights.map((insight, i) => (
          <li key={i} className="text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
            • {insight}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * PeriodComparison — renders the current vs previous period stats.
 */
export function PeriodComparison({
  data,
}: {
  data: {
    current: { netPL: number; winRate: number; trades: number };
    previous: { netPL: number; winRate: number; trades: number };
    delta: { netPL: number; winRate: number; trades: number };
  } | null;
}) {
  if (!data) return null;
  const { current, previous, delta } = data;
  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">Period comparison</h3>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground uppercase">Metric</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground uppercase">Current</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground uppercase">Previous</div>
        </div>
        <div>Net P/L</div>
        <div
          className={`text-right tabular-nums ${current.netPL >= 0 ? "text-profit" : "text-loss"}`}
        >
          {current.netPL >= 0 ? "+" : ""}
          {current.netPL.toFixed(2)}
        </div>
        <div
          className={`text-right tabular-nums ${previous.netPL >= 0 ? "text-profit" : "text-loss"}`}
        >
          {previous.netPL >= 0 ? "+" : ""}
          {previous.netPL.toFixed(2)}
        </div>
        <div>Win rate</div>
        <div className="text-right tabular-nums">{(current.winRate * 100).toFixed(1)}%</div>
        <div className="text-right tabular-nums">{(previous.winRate * 100).toFixed(1)}%</div>
        <div>Trades</div>
        <div className="text-right tabular-nums">{current.trades}</div>
        <div className="text-right tabular-nums">{previous.trades}</div>
        <div className="font-medium">Change</div>
        <div
          className={`text-right tabular-nums font-medium ${delta.netPL >= 0 ? "text-profit" : "text-loss"}`}
        >
          {delta.netPL >= 0 ? "+" : ""}
          {delta.netPL.toFixed(2)}
        </div>
        <div className="text-right tabular-nums text-muted-foreground">
          {delta.trades >= 0 ? "+" : ""}
          {delta.trades}
        </div>
      </div>
    </div>
  );
}
