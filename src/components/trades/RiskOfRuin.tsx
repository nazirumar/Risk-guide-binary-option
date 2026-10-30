"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function riskOfRuinApprox(winRate: number, payoutPercent: number, riskPercent: number): number {
  if (winRate <= 0) return 100;
  if (winRate >= 1) return 0;
  
  const edge = winRate * (1 + payoutPercent) - 1;
  if (edge <= 0) return 99.9;
  
  const q = 1 - winRate;
  const p = winRate;
  const b = payoutPercent;
  const f = riskPercent / 100;
  
  if (f <= 0) return 0;
  if (f >= 1) return 100;
  
  const ruin = Math.pow(q / (p * (1 + b)), 1 / f);
  return Math.min(99.9, Math.max(0.1, ruin * 100));
}

export function RiskOfRuin() {
  const [winRate, setWinRate] = useState("55");
  const [payout, setPayout] = useState("85");
  const [riskPerTrade, setRiskPerTrade] = useState("2");

  const wr = parseFloat(winRate) / 100;
  const pay = parseFloat(payout) / 100;
  const risk = parseFloat(riskPerTrade);

  const ror = riskOfRuinApprox(wr, pay, risk);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4" />
          Risk of Ruin
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
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
          <div className="space-y-1.5">
            <Label htmlFor="risk" className="text-xs">
              Risk/Trade (%)
            </Label>
            <Input
              id="risk"
              type="number"
              value={riskPerTrade}
              onChange={(e) => setRiskPerTrade(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-t pt-2">
            <span className="text-muted-foreground">Risk of Ruin (approx)</span>
            <span
              className={`font-medium ${
                ror > 50 ? "text-loss" : ror > 20 ? "text-yellow-500" : "text-profit"
              }`}
            >
              {ror.toFixed(1)}%
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {ror > 50
              ? "Very high risk. Reduce risk per trade or improve edge."
              : ror > 20
                ? "Moderate risk. Consider lowering risk per trade."
                : "Lower risk with current parameters."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
