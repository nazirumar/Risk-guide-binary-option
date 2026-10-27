import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";
import Decimal from "decimal.js";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/**
 * PercentBadge — small pill showing a percentage with up/down arrow + color.
 *
 *   <PercentBadge value={0.084} />        → +8.40% (green up arrow)
 *   <PercentBadge value={-0.04} />        → -4.00% (red down arrow)
 *   <PercentBadge value={0} />             → 0.00% (neutral)
 */
export function PercentBadge({
  value,
  alreadyPercent = false,
  className,
  decimals = 2,
  size = "sm",
}: {
  value: number | Decimal | string | null | undefined;
  alreadyPercent?: boolean;
  className?: string;
  decimals?: number;
  size?: "sm" | "md";
}) {
  if (value === null || value === undefined) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
          className,
        )}
      >
        —
      </span>
    );
  }

  const v = new Decimal(value.toString());
  const pct = alreadyPercent ? v : v.mul(100);
  const display = formatPercent(pct, { alreadyPercent: true, decimals, signed: true });
  const isUp = pct.gt(0);
  const isDown = pct.lt(0);

  const sizeCls = size === "sm" ? "text-xs px-1.5 py-0.5" : "text-sm px-2 py-1";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md font-medium tabular-nums",
        sizeCls,
        isUp && "bg-profit/15 text-profit",
        isDown && "bg-loss/15 text-loss",
        !isUp && !isDown && "bg-muted text-muted-foreground",
        className,
      )}
    >
      {isUp ? (
        <ArrowUp className="size-3" aria-hidden="true" />
      ) : isDown ? (
        <ArrowDown className="size-3" aria-hidden="true" />
      ) : (
        <Minus className="size-3" aria-hidden="true" />
      )}
      {display}
    </span>
  );
}
