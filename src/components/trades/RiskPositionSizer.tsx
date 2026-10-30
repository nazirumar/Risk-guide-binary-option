"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function RiskPositionSizer() {
  const [balance, setBalance] = useState("1000");
  const [riskPercent, setRiskPercent] = useState("2");

  const balanceNum = parseFloat(balance) || 0;
  const riskPercentNum = parseFloat(riskPercent) || 0;
  const riskAmount = balanceNum * (riskPercentNum / 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4" />
          Risk Position Sizer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="balance" className="text-xs">
              Account Balance ($)
            </Label>
            <Input
              id="balance"
              type="number"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="risk" className="text-xs">
              Risk Per Trade (%)
            </Label>
            <Input
              id="risk"
              type="number"
              value={riskPercent}
              onChange={(e) => setRiskPercent(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-t pt-2">
            <span className="text-muted-foreground">Risk Amount</span>
            <span className="font-medium text-loss">${riskAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Stake (if risking this)</span>
            <span className="font-medium">${riskAmount.toFixed(2)}</span>
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            Only risk what you can afford to lose. Follow your risk rules.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
