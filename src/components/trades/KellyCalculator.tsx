"use client";

import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function KellyCalculator() {
  const [winRate, setWinRate] = useState("55");
  const [payout, setPayout] = useState("85");

  const wr = parseFloat(winRate) / 100;
  const pay = parseFloat(payout) / 100;

  // Kelly = (p*b - q) / b where p=win prob, q=lose prob, b=odds/payout
  const q = 1 - wr;
  const kelly = (wr * (1 + pay) - 1) / pay;
  const kellyPercent = Math.max(0, kelly * 100);
  const halfKelly = kellyPercent / 2;
  const quarterKelly = kellyPercent / 4;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          Kelly Criterion
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="winrate" className="text-xs">
              Win Rate (%)
            </Label>
            <Input
              id="winrate"
              type="number"
              value={winRate}
              onChange={(e) => setWinRate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payout" className="text-xs">
              Payout (%)
            </Label>
            <Input
              id="payout"
              type="number"
              value={payout}
              onChange={(e) => setPayout(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Full Kelly</span>
            <span className="font-medium">{kellyPercent.toFixed(2)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Half Kelly (Recommended)</span>
            <span className="font-medium text-profit">{halfKelly.toFixed(2)}%</span>
          </div>
          <div className="flex justify-between border-t pt-2">
            <span className="text-muted-foreground">Quarter Kelly (Conservative)</span>
            <span className="font-medium">{quarterKelly.toFixed(2)}%</span>
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            {kellyPercent <= 0
              ? "Negative edge - Kelly suggests no trade"
              : "Use fractional Kelly for safety"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
