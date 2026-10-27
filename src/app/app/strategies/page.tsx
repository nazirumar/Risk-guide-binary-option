import Link from "next/link";
import { PieChart } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { listStrategiesWithStatsAction } from "@/server/actions/strategies";
import { EmptyState } from "@/components/trader/EmptyState";
import { CreateStrategyForm } from "@/components/strategies/CreateStrategyForm";
import { ReliabilityBadge, VerdictPill } from "@/components/strategies/ReliabilityBadge";
import { DeleteStrategyButton } from "@/components/strategies/DeleteStrategyButton";

/**
 * /app/strategies — Phase 20 Strategy list + comparison.
 *
 * Server Component. Layout:
 *   - Header (count + disclaimer).
 *   - Strategy comparison table (with badges + verdicts).
 *   - Create-strategy form (right column on desktop, bottom on mobile).
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 * rule #11: visible risk disclaimer — past results don't guarantee future results.
 */
export default async function StrategiesPage() {
  const { userId } = await requireUser();
  const result = await listStrategiesWithStatsAction();
  const strategies = result.strategies ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Strategies</h1>
        <p className="text-sm text-muted-foreground">
          {strategies.length} strategy{strategies.length === 1 ? "" : "s"} · statistical reliability
          per strategy
        </p>
      </div>

      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="strategy-disclaimer"
      >
        <strong className="text-foreground">Disclaimer.</strong> Past performance does not guarantee
        future results. These statistics describe historical trades — they are a discipline aid, not
        a prediction. A strategy that was profitable historically may still lose money going
        forward. Always size positions within your risk rules.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Comparison table — 2/3 width */}
        <div className="lg:col-span-2 space-y-4">
          {strategies.length === 0 ? (
            <EmptyState
              icon={PieChart}
              title="No strategies yet"
              description="Create your first strategy to start tracking per-setup stats. You'll see reliability ratings and verdicts as trades accumulate."
            />
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Comparison</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="strategies-comparison-table">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5">Strategy</th>
                      <th className="px-4 py-2.5 text-right">Trades</th>
                      <th className="px-4 py-2.5 text-right">Win rate</th>
                      <th className="px-4 py-2.5 text-right">Break-even</th>
                      <th className="px-4 py-2.5">Reliability</th>
                      <th className="px-4 py-2.5">Verdict</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {strategies.map((s) => (
                      <tr key={s.id} data-testid={`strategy-row-${s.id}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="size-3 rounded-sm shrink-0"
                              style={{ backgroundColor: s.color }}
                              aria-hidden="true"
                            />
                            <Link
                              href={`/app/strategies/${s.id}`}
                              className="font-medium hover:underline"
                            >
                              {s.name}
                            </Link>
                            {!s.isActive && (
                              <span className="text-[10px] text-muted-foreground">(paused)</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{s.totalTrades}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {s.winRate == null ? "—" : `${(s.winRate * 100).toFixed(1)}%`}
                          {s.totalTrades > 0 &&
                            s.reliability.wilsonLower !== s.reliability.wilsonUpper && (
                              <span className="block text-[10px] text-muted-foreground">
                                [{(s.reliability.wilsonLower * 100).toFixed(1)}%–
                                {(s.reliability.wilsonUpper * 100).toFixed(1)}%]
                              </span>
                            )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {(s.reliability.breakEvenWinRate * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-3">
                          <ReliabilityBadge assessment={s.reliability} />
                        </td>
                        <td className="px-4 py-3">
                          <VerdictPill verdict={s.reliability.verdict} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <DeleteStrategyButton strategyId={s.id} strategyName={s.name} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Create-strategy form — 1/3 width */}
        <div className="lg:col-span-1">
          <CreateStrategyForm />
        </div>
      </div>
    </div>
  );
}
