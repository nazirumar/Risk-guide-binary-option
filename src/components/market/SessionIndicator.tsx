"use client";

import { Clock } from "lucide-react";
import { classifyTradeBySession } from "@/lib/news/sessions";

const SESSION_LABELS: Record<string, string> = {
  ASIAN: "Asian Session",
  LONDON: "London Session",
  NEW_YORK: "New York Session",
  LONDON_NY_OVERLAP: "London-NY Overlap",
  OFF_HOURS: "Off Hours",
};

const SESSION_COLORS: Record<string, string> = {
  ASIAN: "text-blue-500",
  LONDON: "text-green-500",
  NEW_YORK: "text-orange-500",
  LONDON_NY_OVERLAP: "text-red-500",
  OFF_HOURS: "text-gray-500",
};

export function SessionIndicator() {
  const session = classifyTradeBySession(new Date());
  const label = SESSION_LABELS[session] || session;
  const color = SESSION_COLORS[session] || "text-muted-foreground";

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border bg-card text-sm">
      <Clock className={`h-4 w-4 ${color}`} />
      <span className={color}>{label}</span>
      <span className="text-xs text-muted-foreground">(UTC)</span>
    </div>
  );
}
