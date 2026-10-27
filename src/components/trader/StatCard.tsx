import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";

/**
 * StatCard — the workhorse display for dashboard metrics.
 *
 *   <StatCard
 *     label="Today P/L"
 *     value="+$127.34"
 *     delta="+8.4% vs yesterday"
 *     trend="up"
 *     icon={TrendingUp}
 *   />
 */
type Trend = "up" | "down" | "neutral";

export function StatCard({
  label,
  value,
  delta,
  trend = "neutral",
  icon: Icon,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  delta?: string;
  trend?: Trend;
  icon?: LucideIcon;
  hint?: string;
  className?: string;
}) {
  return (
    <Card className={cn("p-4 flex flex-col gap-2", className)}>
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
      </div>
      <div className="text-2xl font-bold tabular-nums tracking-tight">{value}</div>
      {delta && (
        <div
          className={cn(
            "text-xs font-medium",
            trend === "up" && "text-profit",
            trend === "down" && "text-loss",
            trend === "neutral" && "text-muted-foreground",
          )}
        >
          {delta}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
