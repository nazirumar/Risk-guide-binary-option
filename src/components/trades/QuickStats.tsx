"use client";

import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function QuickStats({
  totalTrades = 0,
  winRate = 0,
  profitLoss = 0,
}: {
  totalTrades?: number;
  winRate?: number;
  profitLoss?: number;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Trades</p>
              <p className="text-lg font-semibold">{totalTrades}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Win Rate</p>
              <p className="text-lg font-semibold">{winRate.toFixed(1)}%</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            {profitLoss >= 0 ? (
              <TrendingUp className="h-4 w-4 text-profit" />
            ) : (
              <TrendingDown className="h-4 w-4 text-loss" />
            )}
            <div>
              <p className="text-xs text-muted-foreground">P/L</p>
              <p className={`text-lg font-semibold ${profitLoss >= 0 ? "text-profit" : "text-loss"}`}>
                {profitLoss >= 0 ? "+" : ""}${profitLoss.toFixed(2)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
