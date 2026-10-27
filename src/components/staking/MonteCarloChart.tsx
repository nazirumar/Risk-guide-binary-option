"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { MonteCarloResult } from "@/lib/staking";
import { formatMoney } from "@/lib/format";

/**
 * MonteCarloChart — histogram of ending balances from the simulation.
 *
 * Shows the distribution of 1,000 simulated outcomes (binned into 10 bars),
 * with the starting balance marked via a reference line in the tooltip.
 */
export function MonteCarloChart({
  result,
  currency,
}: {
  result: MonteCarloResult;
  currency: string;
}) {
  const data = result.histogram.map((bin) => ({
    label: bin.label,
    count: bin.count,
  }));

  return (
    <div className="w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            angle={-30}
            textAnchor="end"
            height={50}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            label={{
              value: "# of sims",
              angle: -90,
              position: "insideLeft",
              style: { fontSize: 10, fill: "var(--muted-foreground)" },
            }}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              backgroundColor: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            formatter={(value: number) => [`${value} sims`, "Ending balance"]}
            labelFormatter={(label) => `${label} ${currency}`}
          />
          <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted-foreground text-center mt-1">
        Distribution of ending balances across {result.numSimulations} simulations of{" "}
        {result.numTradesPerSim} trades each. Starting balance:{" "}
        {formatMoney(result.startingBalance, currency)}.
      </p>
    </div>
  );
}
