"use client";

import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRecommendedExpiry } from "@/lib/market/expiry-recommendations";

export function ExpirySuggestion() {
  const session = "LONDON";
  const volatilityPercentile = 45;
  const rec = getRecommendedExpiry(session, volatilityPercentile);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" />
          Suggested Expiry
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-2xl font-bold">{rec.expiry} min</span>
          <span className="text-xs text-muted-foreground">Recommended</span>
        </div>
        <p className="text-xs text-muted-foreground">{rec.reason}</p>
      </CardContent>
    </Card>
  );
}
