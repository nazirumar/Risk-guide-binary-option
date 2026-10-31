"use client";

import { Flame } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TradingStreak({ currentStreak = 0, bestStreak = 0 }: { currentStreak?: number; bestStreak?: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="h-4 w-4 text-orange-500" />
          Trading Streak
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">Current Streak</span>
          <span className="font-medium">{currentStreak} wins</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">Best Streak</span>
          <span className="font-medium">{bestStreak} wins</span>
        </div>
      </CardContent>
    </Card>
  );
}
