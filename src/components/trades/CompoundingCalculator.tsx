"use client";

import { useState } from "react";
import { Repeat } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CompoundingCalculator() {
  const [startingBalance, setStartingBalance] = useState("1000");
  const [winRate, setWinRate] = useState("55");
  const [payout, setPayout] = useState("85");
  const [trades, setTrades] = useState("50");
  const [riskPerTrade, setRiskPerTrade] = useState("2");

  const start = parseFloat(startingBalance) || 0;
  const wr = (parseFloat(winRate) || 0) / 100;
  const pay = (parseFloat(payout) || 0) / 100;
  const n = parseInt(trades) || 0;
  const risk = (parseFloat(riskPerTrade) || 0) / 100;

  // Expected value per trade
  const edge = wr * (1 + pay) - 1;
  // Geometric compounding approximation: balance * (1 + risk * edge)^n
  const projected = start * Math.pow(1 + risk * edge, n);
  const gain = projected - start;
  const gainPercent = start > 0 ? (gain / start) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Repeat className="h-4 w-4" />
          Compounding Projector
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="start" className="text-xs">
              Starting Balance ($)
            </Label>
            <Input
              id="start"
              type="number"
              value={startingBalance}
              onChange={(e) => setStartingBalance(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trades" className="text-xs">
              Number of Trades
            </Label>
            <Input
              id="trades"
              type="number"
              value={trades}
              onChange={(e) => setTrades(e.target.value)}
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
          <div className="space-y-1.5 col-span-2">
            <Label htmlFor="risk" className="text-xs">
              Risk Per Trade (%)
            </Label>
            <Input
              id="risk"
              type="number"
              value={riskPerTrade}
              onChange={(e) => setRiskPerTrade(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2 text-sm border-t pt-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Projected Balance</span>
            <span className="font-medium">${projected.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Net Gain/Loss</span>
            <span className={`font-medium ${gain >= 0 ? "text-profit" : "text-loss"}`}>
              {gain >= 0 ? "+" : ""}${gain.toFixed(2)} ({gainPercent >= 0 ? "+" : ""}{gainPercent.toFixed(1)}%)
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {edge <= 0
              ? "Negative edge - compounding will erode your account over time."
              : "Projection based on expected value. Actual results will vary."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
