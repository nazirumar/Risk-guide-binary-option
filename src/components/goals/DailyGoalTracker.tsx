"use client";

import { Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function DailyGoalTracker({
  goalAmount = 100,
  currentAmount = 0,
}: {
  goalAmount?: number;
  currentAmount?: number;
}) {
  const progress = Math.min((currentAmount / goalAmount) * 100, 100);
  const isComplete = currentAmount >= goalAmount;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4" />
          Daily Goal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Progress</span>
          <span className={`font-medium ${isComplete ? "text-profit" : ""}`}>
            ${currentAmount.toFixed(2)} / ${goalAmount.toFixed(2)}
          </span>
        </div>
        <Progress value={progress} className="h-2" />
        {isComplete && (
          <p className="text-xs text-profit text-center">Goal achieved! 🎉</p>
        )}
      </CardContent>
    </Card>
  );
}
