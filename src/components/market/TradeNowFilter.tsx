"use client";

import { useState } from "react";
import { Filter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function TradeNowFilter({
  onFilterChange,
}: {
  onFilterChange?: (filters: { tradeNowOnly: boolean }) => void;
}) {
  const [tradeNowOnly, setTradeNowOnly] = useState(false);

  const toggle = (checked: boolean) => {
    setTradeNowOnly(checked);
    onFilterChange?.({ tradeNowOnly: checked });
  };

  return (
    <div className="flex items-center gap-2 p-3 rounded-lg border bg-card">
      <Filter className="h-4 w-4 text-muted-foreground" />
      <Checkbox id="trade-now" checked={tradeNowOnly} onCheckedChange={toggle} />
      <Label htmlFor="trade-now" className="text-sm cursor-pointer">
        Trade Now Only (GOOD + open market + no imminent news)
      </Label>
    </div>
  );
}
