"use client";

import { useState } from "react";
import { Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { calculateBreakevenWinRate } from "@/lib/calc/payout";

export function WinRateNeeded() {
  const [payout, setPayout] = useState("85");

  const payoutNum = (parseFloat(payout) || 0) / 100;
  const breakeven = calculateBreakevenWinRate(payoutNum) * 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4" />
          Win Rate Needed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="payout" className="text-xs">
            Broker Payout (%)
          </Label>
          <Input
            id="payout"
            type="number"
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
          />
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-t pt-2">
            <span className="text-muted-foreground">Breakeven Win Rate</span>
            <span className="font-medium">{breakeven.toFixed(1)}%</span>
          </div>
          <p className="text-xs text-muted-foreground">
            You need to win at least {breakeven.toFixed(1)}% of trades to break even at {payout}% payout.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
