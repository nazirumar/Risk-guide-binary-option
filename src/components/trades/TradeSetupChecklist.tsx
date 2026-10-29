"use client";

import { useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

const DEFAULT_ITEMS = [
  "Checked market conditions (rating GOOD/CAUTION)",
  "Verified no high-impact news in next 30 min",
  "Confirmed entry reason & setup",
  "Checked risk % within limits",
  "Selected appropriate expiry time",
  "Reviewed recent trade history (no revenge trading)",
  "Emotion is calm and objective",
];

export function TradeSetupChecklist({ onComplete }: { onComplete?: (done: boolean) => void }) {
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const toggle = (idx: number) => {
    const newChecked = { ...checked, [idx]: !checked[idx] };
    setChecked(newChecked);
    const allDone = DEFAULT_ITEMS.every((_, i) => newChecked[i]);
    onComplete?.(allDone);
  };

  const completedCount = Object.values(checked).filter(Boolean).length;
  const allDone = completedCount === DEFAULT_ITEMS.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Pre-Trade Checklist</span>
          <span className="text-sm text-muted-foreground">
            {completedCount}/{DEFAULT_ITEMS.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {DEFAULT_ITEMS.map((item, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <Checkbox
              id={`check-${idx}`}
              checked={checked[idx] || false}
              onCheckedChange={() => toggle(idx)}
            />
            <label
              htmlFor={`check-${idx}`}
              className={`text-sm cursor-pointer ${
                checked[idx] ? "line-through text-muted-foreground" : ""
              }`}
            >
              {item}
            </label>
          </div>
        ))}
        {allDone && (
          <div className="flex items-center gap-2 text-sm text-profit pt-2 border-t">
            <CheckCircle2 className="h-4 w-4" />
            <span>Checklist complete - Ready to trade</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
