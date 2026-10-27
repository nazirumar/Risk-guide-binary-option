import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import Decimal from "decimal.js";

/**
 * MoneyText — formats a money amount with the right currency symbol + sign
 * and colors it green (positive) / red (negative) automatically.
 *
 *   <MoneyText amount={profitLoss} currency="USD" signed />
 *   // → <span class="text-profit">+$127.34</span>
 *
 * For zero values, renders in muted gray with no sign.
 */
export function MoneyText({
  amount,
  currency = "USD",
  signed = false,
  className,
  showOnZero = true,
}: {
  amount: Decimal | string | number | null | undefined;
  currency?: string;
  signed?: boolean;
  className?: string;
  showOnZero?: boolean;
}) {
  if (amount === null || amount === undefined) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  const value = new Decimal(amount.toString());
  if (value.isZero()) {
    if (!showOnZero) return null;
    return (
      <span className={cn("text-muted-foreground tabular-nums", className)}>
        {formatMoney(value, currency)}
      </span>
    );
  }
  const positive = value.gt(0);
  const display = formatMoney(value, currency, { signed });
  return (
    <span
      className={cn("tabular-nums font-medium", positive ? "text-profit" : "text-loss", className)}
    >
      {display}
    </span>
  );
}
