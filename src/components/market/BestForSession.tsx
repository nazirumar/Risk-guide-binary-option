"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { classifyTradeBySession } from "@/lib/news/sessions";
import { SESSION_FOCUS_PAIRS } from "@/lib/market/session-recommendations";

const SESSION_LABELS: Record<string, string> = {
  ASIAN: "Asian Session",
  LONDON: "London Session",
  NEW_YORK: "New York Session",
  LONDON_NY_OVERLAP: "London-NY Overlap",
  OFF_HOURS: "Off Hours",
};

export function BestForSession() {
  const [session, setSession] = useState<string>("LONDON");
  const [pairs, setPairs] = useState<string[]>([]);

  useEffect(() => {
    const s = classifyTradeBySession(new Date());
    setSession(s);
    setPairs(SESSION_FOCUS_PAIRS[s] || []);
  }, []);

  if (pairs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4 text-yellow-500" />
          Best for {SESSION_LABELS[session] || session}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {pairs.slice(0, 4).map((pair) => (
          <Button
            key={pair}
            size="sm"
            variant="outline"
            onClick={() => (window.location.href = `/app/trades?asset=${pair}`)}
          >
            {pair.replace("_", "/")} - Trade Now
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
