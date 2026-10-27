import { notFound } from "next/navigation";
import { ArrowLeft, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import Link from "next/link";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { getStrategyValidationAction } from "@/server/actions/strategies";
import { formatMoney, formatDate } from "@/lib/format";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { Button } from "@/components/ui/button";
import { ReliabilityBadge, VerdictPill } from "@/components/strategies/ReliabilityBadge";
import { WinRateConfidenceChart } from "@/components/strategies/WinRateConfidenceChart";
import { RecomputeStatsButton } from "@/components/strategies/RecomputeStatsButton";
import Decimal from "decimal.js";

/**
 * /app/strategies/[id] — Phase 20 Strategy detail page.
 *
 * Server Component. Layout:
 *   - Header (name, color, description, verdict, disclaimer).
 *   - Stat grid (trades, win rate with Wilson range, break-even win rate,
 *     Wilson lower bound).
 *   - Win-rate confidence band chart (running Wilson over trade history).
 *   - Recent trades list under this strategy.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 * rule #11: past-results disclaimer is visible.
 */
export default async function StrategyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const { id } = await params;

  // Verify the strategy belongs to the user.
  const exists = await db.strategy.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!exists) notFound();

  const result = await getStrategyValidationAction(id);
  if (!result.ok || !result.strategy) {
    notFound();
  }
  const s = result.strategy;

  // Fetch recent trades under this strategy.
  const recentTrades = await db.trade.findMany({
    where: { userId, strategyId: id, result: { in: ["WIN", "LOSS", "TIE"] } },
    orderBy: { openedAt: "desc" },
    take: 20,
    select: {
      id: true,
      asset: true,
      direction: true,
      result: true,
      stake: true,
      profitLoss: true,
      openedAt: true,
      tradingAccount: { select: { currency: true } },
    },
  });

  const winRateDisplay = s.winRate == null ? "—" : `${(s.winRate * 100).toFixed(1)}%`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <Link
          href="/app/strategies"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All strategies
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="size-5 rounded-md shrink-0"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{s.name}</h1>
              {s.description && (
                <p className="text-sm text-muted-foreground mt-0.5 max-w-prose">{s.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RecomputeStatsButton strategyId={s.id} />
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="strategy-detail-disclaimer"
      >
        <strong className="text-foreground">Disclaimer.</strong> {s.disclaimer}
      </div>

      {/* Verdict + reliability badge */}
      <div className="rounded-lg border border-border p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ReliabilityBadge assessment={s.reliability} size="md" />
          <VerdictPill verdict={s.reliability.verdict} size="md" />
        </div>
        <div className="text-xs text-muted-foreground">
          Wilson 95%: [{(s.reliability.wilsonLower * 100).toFixed(1)}%,
          {(s.reliability.wilsonUpper * 100).toFixed(1)}%]
          {s.reliability.pValue < 0.5 && (
            <span className="ml-2">p = {s.reliability.pValue.toFixed(4)}</span>
          )}
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Closed trades"
          value={s.totalTrades}
          delta={s.reliability.rating === "INSUFFICIENT" ? "Need 30+ for verdict" : undefined}
          icon={s.totalTrades >= 30 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Win rate"
          value={winRateDisplay}
          delta={
            s.totalTrades > 0
              ? `Range [${(s.reliability.wilsonLower * 100).toFixed(1)}%–${(s.reliability.wilsonUpper * 100).toFixed(1)}%]`
              : "No trades yet"
          }
          trend={
            s.winRate != null && s.winRate > s.reliability.breakEvenWinRate
              ? "up"
              : s.winRate != null
                ? "down"
                : "neutral"
          }
          icon={TrendingUp}
        />
        <StatCard
          label="Break-even win rate"
          value={`${(s.reliability.breakEvenWinRate * 100).toFixed(1)}%`}
          delta={`At ${s.averagePayout.toFixed(2)} payout`}
          icon={TrendingUp}
        />
        <StatCard
          label="Wilson lower bound"
          value={`${(s.reliability.wilsonLower * 100).toFixed(1)}%`}
          delta={
            s.reliability.wilsonLower > s.reliability.breakEvenWinRate
              ? "Beats break-even ✓"
              : "Below break-even"
          }
          trend={s.reliability.wilsonLower > s.reliability.breakEvenWinRate ? "up" : "down"}
          icon={TrendingUp}
        />
      </div>

      {/* Wilson confidence band chart */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Win-rate confidence band</h2>
          <p className="text-xs text-muted-foreground">
            Wilson 95% interval — shrinks as trades accumulate
          </p>
        </div>
        <WinRateConfidenceChart
          history={s.history}
          breakEvenWinRate={s.reliability.breakEvenWinRate}
          height={280}
        />
      </div>

      {/* Cached extras */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        <div className="rounded-md border border-border p-3">
          <div className="text-muted-foreground uppercase tracking-wide">Expectancy / trade</div>
          <div className="text-sm font-medium tabular-nums mt-1">
            {s.expectancyPerTrade == null
              ? "—"
              : formatMoney(new Decimal(s.expectancyPerTrade), "USD", { signed: true })}
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-muted-foreground uppercase tracking-wide">Profit factor</div>
          <div className="text-sm font-medium tabular-nums mt-1">
            {s.profitFactor == null ? "—" : s.profitFactor.toFixed(2)}
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-muted-foreground uppercase tracking-wide">Last recomputed</div>
          <div className="text-sm font-medium mt-1">
            {s.lastValidatedAt ? formatDate(s.lastValidatedAt, { withTime: true }) : "Never"}
          </div>
        </div>
      </div>

      {/* Recent trades */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Recent trades under this strategy</h2>
        </div>
        {recentTrades.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={TrendingUp}
              title="No closed trades yet"
              description="As you tag trades with this strategy and close them, their stats will feed the reliability rating above."
              actionLabel="Add trade"
              actionHref="/app/trades"
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {recentTrades.map((t) => {
              const pl = new Decimal(t.profitLoss.toString());
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        t.direction === "CALL" ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss"
                      }`}
                    >
                      {t.direction}
                    </span>
                    <span className="font-mono text-sm">{t.asset}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(t.openedAt, { withTime: true })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-xs font-medium ${
                        t.result === "WIN"
                          ? "text-profit"
                          : t.result === "LOSS"
                            ? "text-loss"
                            : "text-muted-foreground"
                      }`}
                    >
                      {t.result}
                    </span>
                    <span
                      className={`text-sm tabular-nums ${pl.gte(0) ? "text-profit" : "text-loss"}`}
                    >
                      {pl.gte(0) ? "+" : "−"}
                      {formatMoney(pl.abs(), t.tradingAccount.currency)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
