"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  calculateProfit,
  calculateBreakevenWinRate,
  calculateExpectedValue,
} from "@/lib/calc/payout";

export function PayoutCalculator() {
  const [stake, setStake] = useState("10");
  const [payout, setPayout] = useState("85");
  const [winRate, setWinRate] = useState("55");

  const stakeNum = parseFloat(stake) || 0;
  const payoutNum = (parseFloat(payout) || 0) / 100;
  const winRateNum = (parseFloat(winRate) || 0) / 100;

  const profit = calculateProfit(stakeNum, payoutNum);
  const breakeven = calculateBreakevenWinRate(payoutNum) * 100;
  const ev = calculateExpectedValue(winRateNum, payoutNum, stakeNum);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4" />
          Payout Calculator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="stake" className="text-xs">
              Stake ($)
            </Label>
            <Input
              id="stake"
              type="number"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
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
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Profit if Win</span>
            <span className="font-medium text-profit">+${profit.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Loss if Loss</span>
            <span className="font-medium text-loss">-${stakeNum.toFixed(2)}</span>
          </div>
          <div className="flex justify-between border-t pt-2">
            <span className="text-muted-foreground">Breakeven Win Rate</span>
            <span className="font-medium">{breakeven.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Expected Value</span>
            <span
              className={`font-medium ${ev >= 0 ? "text-profit" : "text-loss"}`}
            >
              {ev >= 0 ? "+" : ""}${ev.toFixed(2)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
