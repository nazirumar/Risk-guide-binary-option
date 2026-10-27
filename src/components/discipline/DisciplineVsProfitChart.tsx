"use client";

/**
 * Phase 21 — Weekly "discipline vs profit" chart.
 *
 * Renders a Recharts BarChart (or ComposedChart) showing, for the last N
 * weeks (default 8), two series:
 *   - Average discipline score per week (Line, 0-100 scale, primary axis)
 *   - Net profit per week (Bar, account currency, secondary axis)
 *
 * The question the chart answers: "Do disciplined days earn more?" When the
 * discipline line is high and the profit bars are tall, the trader can see
 * the correlation visually. No statistical inference — just visualization.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type WeeklyDisciplineVsProfitPoint = {
  weekLabel: string; // e.g. "W23" or "Jun 9"
  avgScore: number | null; // 0-100
  netProfit: number; // account currency
};

export function DisciplineVsProfitChart({
  data,
  currency = "USD",
  height = 280,
}: {
  data: WeeklyDisciplineVsProfitPoint[];
  currency?: string;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground border border-border rounded-md"
        style={{ height }}
        data-testid="discipline-vs-profit-empty"
      >
        No weekly data yet — the chart will populate as you accumulate trades.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }} data-testid="discipline-vs-profit-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="weekLabel"
            stroke="hsl(var(--muted-foreground))"
            tick={{ fontSize: 11 }}
          />
          {/* Left axis: discipline score (0-100) */}
          <YAxis
            yAxisId="score"
            domain={[0, 100]}
            tickFormatter={(v) => `${v}`}
            stroke="hsl(var(--muted-foreground))"
            tick={{ fontSize: 11 }}
            label={{
              value: "Score",
              angle: -90,
              position: "insideLeft",
              offset: 12,
              fontSize: 10,
              fill: "hsl(var(--muted-foreground))",
            }}
          />
          {/* Right axis: net profit (currency) */}
          <YAxis
            yAxisId="profit"
            orientation="right"
            tickFormatter={(v) => `${v < 0 ? "-" : ""}${currency}${Math.abs(v).toFixed(0)}`}
            stroke="hsl(var(--muted-foreground))"
            tick={{ fontSize: 11 }}
            label={{
              value: `Net P/L (${currency})`,
              angle: 90,
              position: "insideRight",
              offset: 8,
              fontSize: 10,
              fill: "hsl(var(--muted-foreground))",
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => {
              if (name === "avgScore") return [value ?? "—", "Avg score"];
              if (name === "netProfit")
                return [
                  `${value < 0 ? "-" : ""}${currency}${Math.abs(value).toFixed(2)}`,
                  "Net P/L",
                ];
              return [String(value), name];
            }}
          />
          {/* Disciplined-day threshold line */}
          <ReferenceLine
            y={80}
            yAxisId="score"
            stroke="hsl(var(--profit))"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: "Disciplined (≥80)",
              position: "right",
              fontSize: 10,
              fill: "hsl(var(--profit))",
            }}
          />
          {/* Net profit bars (currency, right axis) */}
          <Bar
            yAxisId="profit"
            type="monotone"
            dataKey="netProfit"
            stroke="hsl(var(--info))"
            fill="hsl(var(--info) / 0.4)"
            isAnimationActive={false}
          />
          {/* Avg discipline score line (left axis) */}
          <Line
            yAxisId="score"
            type="monotone"
            dataKey="avgScore"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Re-export BarChart for type-check compatibility — not used directly here
// but Recharts requires the import for tree-shaking.
void BarChart;
