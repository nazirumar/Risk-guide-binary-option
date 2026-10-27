"use client";

/**
 * Phase 20 — Win-rate confidence band chart.
 *
 * Renders the running Wilson 95% interval over the strategy's trade history
 * as the band shrinks while trades accumulate. Three series:
 *   - Lower bound (light fill, top edge at lower)
 *   - Upper bound (light fill, bottom edge at lower, top edge at upper —
 *     shaded area chart between lower and upper)
 *   - Observed win rate (center line)
 *
 * Recharts is used (already a Phase 6 dependency). The chart is purely
 * presentational — the data is computed server-side by
 * `getStrategyValidationAction` and passed in.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ComposedChart,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export type HistoryPoint = {
  tradeNumber: number;
  lower: number;
  upper: number;
  winRate: number;
};

export function WinRateConfidenceChart({
  history,
  breakEvenWinRate,
  height = 280,
}: {
  history: HistoryPoint[];
  breakEvenWinRate: number;
  height?: number;
}) {
  if (history.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground border border-border rounded-md"
        style={{ height }}
        data-testid="win-rate-chart-empty"
      >
        No closed trades yet — the band will form as you close trades under this strategy.
      </div>
    );
  }

  // Recharts renders an area between two series using two stacked Area
  // components: the first fills from 0 to `lower` (transparent), the second
  // fills from `lower` to `upper` (the visible band). This is the standard
  // recharts "band chart" pattern.
  const data = history.map((h) => ({
    tradeNumber: h.tradeNumber,
    bandStart: h.lower,
    bandEnd: h.upper,
    bandWidth: h.upper - h.lower,
    winRate: h.winRate,
    lower: h.lower,
    upper: h.upper,
  }));

  return (
    <div className="w-full" style={{ height }} data-testid="win-rate-confidence-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="tradeNumber"
            type="number"
            domain={[1, data.length]}
            tickFormatter={(v) => `#${v}`}
            stroke="hsl(var(--muted-foreground))"
            tick={{ fontSize: 11 }}
            label={{
              value: "Trade #",
              position: "insideBottomRight",
              offset: -4,
              fontSize: 11,
              fill: "hsl(var(--muted-foreground))",
            }}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(v) => `${Math.round(v * 100)}%`}
            stroke="hsl(var(--muted-foreground))"
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => {
              if (typeof value !== "number") return String(value);
              const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
              switch (name) {
                case "winRate":
                  return [pct(value), "Observed win rate"];
                case "lower":
                  return [pct(value), "Wilson lower bound"];
                case "upper":
                  return [pct(value), "Wilson upper bound"];
                default:
                  return [pct(value), name];
              }
            }}
            labelFormatter={(label) => `Trade #${label}`}
          />
          {/* The shaded band — stacked Area approach (transparent base + visible band) */}
          <Area
            type="monotone"
            dataKey="lower"
            stackId="band"
            stroke="none"
            fill="none"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="bandWidth"
            stackId="band"
            stroke="hsl(var(--primary))"
            strokeWidth={1}
            fill="hsl(var(--primary) / 0.15)"
            isAnimationActive={false}
          />
          {/* Break-even reference line */}
          <ReferenceLine
            y={breakEvenWinRate}
            stroke="hsl(var(--warning))"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: `Break-even ${(breakEvenWinRate * 100).toFixed(1)}%`,
              position: "right",
              fontSize: 10,
              fill: "hsl(var(--warning))",
            }}
          />
          {/* Observed win rate line */}
          <Line
            type="monotone"
            dataKey="winRate"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
