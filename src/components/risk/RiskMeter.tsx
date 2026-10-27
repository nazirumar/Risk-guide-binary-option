"use client";

import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { TrendingDown, TrendingUp, AlertTriangle, Activity, Layers, Clock } from "lucide-react";
import Decimal from "decimal.js";
import { formatMoney, formatPercent } from "@/lib/format";

type RiskMeterData = {
  balance: string;
  currency: string;
  dailyPL: string;
  maxDailyLossPercent: string | null;
  maxDailyLossAmount: string | null;
  tradesToday: number;
  maxTradesPerDay: number;
  openTrades: number;
  maxOpenTrades: number;
  currentLossStreak: number;
  maxConsecutiveLosses: number;
  dailyProfitTargetPercent: string | null;
};

/**
 * RiskMeter — live widget for the dashboard. Renders 4 progress bars:
 *   1. Daily loss used % (amber at >60%, red at >80%)
 *   2. Trades used today / max
 *   3. Open trades / max
 *   4. Loss streak / max-consec
 *
 * Server-rendered with current state (no polling). Re-renders after each
 * trade close because the parent layout calls router.refresh() (via the
 * closeTradeAction toast).
 */
export function RiskMeter({ data }: { data: RiskMeterData }) {
  const balance = new Decimal(data.balance);
  const dailyPL = new Decimal(data.dailyPL);
  const isLoss = dailyPL.lt(0);
  const lossAmount = isLoss ? dailyPL.abs() : new Decimal(0);

  // Compute loss used % — capped at 100 for the progress bar.
  let lossUsedPercent: number = 0;
  let lossLimitLabel: string = "no limit";
  if (data.maxDailyLossAmount) {
    const cap = new Decimal(data.maxDailyLossAmount);
    lossUsedPercent = cap.gt(0) ? Math.min(100, Number(lossAmount.div(cap).mul(100))) : 0;
    lossLimitLabel = `${formatMoney(cap, data.currency)} cap`;
  } else if (data.maxDailyLossPercent) {
    const pct = new Decimal(data.maxDailyLossPercent);
    const cap = balance.mul(pct).div(100);
    lossUsedPercent = cap.gt(0) ? Math.min(100, Number(lossAmount.div(cap).mul(100))) : 0;
    lossLimitLabel = `${pct.toFixed(2)}% of balance`;
  }

  // Profit target used % — green when approaching target.
  let profitUsedPercent: number | null = null;
  let profitTargetLabel: string = "no target";
  if (data.dailyProfitTargetPercent) {
    const pct = new Decimal(data.dailyProfitTargetPercent);
    const target = balance.mul(pct).div(100);
    profitUsedPercent =
      target.gt(0) && dailyPL.gt(0) ? Math.min(100, Number(dailyPL.div(target).mul(100))) : 0;
    profitTargetLabel = `${pct.toFixed(2)}% of balance`;
  }

  // Determine bar color.
  const lossBarColor =
    lossUsedPercent >= 80 ? "bg-loss" : lossUsedPercent >= 60 ? "bg-warning" : "bg-profit";

  const tradesUsedPercent =
    data.maxTradesPerDay > 0 ? (data.tradesToday / data.maxTradesPerDay) * 100 : 0;
  const openTradesPercent =
    data.maxOpenTrades > 0 ? (data.openTrades / data.maxOpenTrades) * 100 : 0;
  const streakPercent =
    data.maxConsecutiveLosses > 0 ? (data.currentLossStreak / data.maxConsecutiveLosses) * 100 : 0;

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
          Risk Meter
        </h2>
        <span
          className={cn("text-xs font-medium tabular-nums", isLoss ? "text-loss" : "text-profit")}
        >
          {isLoss ? "−" : "+"}
          {formatMoney(lossAmount, data.currency)} today
        </span>
      </div>

      {/* Daily loss used */}
      <Bar
        icon={<TrendingDown className="size-3" aria-hidden="true" />}
        label="Daily loss used"
        value={lossUsedPercent}
        colorClass={lossBarColor}
        rightLabel={`${lossUsedPercent.toFixed(0)}% of ${lossLimitLabel}`}
      />

      {/* Daily profit target (only if set) */}
      {profitUsedPercent !== null && (
        <Bar
          icon={<TrendingUp className="size-3" aria-hidden="true" />}
          label="Daily profit target"
          value={profitUsedPercent}
          colorClass="bg-profit"
          rightLabel={`${profitUsedPercent.toFixed(0)}% of ${profitTargetLabel}`}
          hint={profitUsedPercent >= 100 ? "Target reached — stop-when-ahead." : undefined}
        />
      )}

      {/* Trades used today */}
      <Bar
        icon={<Clock className="size-3" aria-hidden="true" />}
        label="Trades today"
        value={tradesUsedPercent}
        colorClass={
          tradesUsedPercent >= 100
            ? "bg-loss"
            : tradesUsedPercent >= 80
              ? "bg-warning"
              : "bg-primary"
        }
        rightLabel={`${data.tradesToday} / ${data.maxTradesPerDay}`}
      />

      {/* Open trades */}
      <Bar
        icon={<Layers className="size-3" aria-hidden="true" />}
        label="Open trades"
        value={openTradesPercent}
        colorClass={
          openTradesPercent >= 100
            ? "bg-loss"
            : openTradesPercent >= 80
              ? "bg-warning"
              : "bg-primary"
        }
        rightLabel={`${data.openTrades} / ${data.maxOpenTrades}`}
      />

      {/* Loss streak */}
      <Bar
        icon={<AlertTriangle className="size-3" aria-hidden="true" />}
        label="Loss streak"
        value={streakPercent}
        colorClass={
          streakPercent >= 100
            ? "bg-loss"
            : streakPercent >= 67
              ? "bg-warning"
              : "bg-muted-foreground"
        }
        rightLabel={`${data.currentLossStreak} / ${data.maxConsecutiveLosses}`}
        hint={streakPercent >= 100 ? "Cooldown will trigger." : undefined}
      />
    </div>
  );
}

function Bar({
  icon,
  label,
  value,
  colorClass,
  rightLabel,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  colorClass: string;
  rightLabel: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-medium tabular-nums">{rightLabel}</span>
      </div>
      <Progress
        value={Math.min(100, value)}
        className={cn("h-2")}
        indicatorClassName={colorClass}
      />
      {hint && <p className="text-[10px] text-warning">{hint}</p>}
    </div>
  );
}
