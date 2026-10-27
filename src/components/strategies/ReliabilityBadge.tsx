/**
 * Phase 20 — Reliability badge component.
 *
 * Renders the sample-size tier (INSUFFICIENT/LOW/MEDIUM/HIGH) and the
 * plain-language verdict with appropriate colors. The verdict never
 * promises future results — the wording is descriptive ("likely profitable"
 * vs "will be profitable"), and a separate disclaimer is shown on the
 * detail page.
 */
import { ShieldCheck, AlertTriangle, HelpCircle, TrendingDown } from "lucide-react";
import type { ReliabilityAssessment } from "@/lib/calc/validation";
import { cn } from "@/lib/utils";

const RATING_STYLES: Record<string, string> = {
  INSUFFICIENT: "bg-muted text-muted-foreground border-muted-foreground/20",
  LOW: "bg-warning/15 text-warning border-warning/30",
  MEDIUM: "bg-info/15 text-info border-info/30",
  HIGH: "bg-profit/15 text-profit border-profit/30",
};

const VERDICT_STYLES: Record<string, string> = {
  "Likely profitable": "text-profit",
  "Likely losing": "text-loss",
  "Can't tell yet": "text-muted-foreground",
  "Not enough data": "text-muted-foreground",
};

function VerdictIcon({ verdict }: { verdict: string }) {
  if (verdict === "Likely profitable")
    return <ShieldCheck className="size-3.5" aria-hidden="true" />;
  if (verdict === "Likely losing") return <TrendingDown className="size-3.5" aria-hidden="true" />;
  if (verdict === "Can't tell yet") return <HelpCircle className="size-3.5" aria-hidden="true" />;
  return <HelpCircle className="size-3.5" aria-hidden="true" />;
}

export function ReliabilityBadge({
  assessment,
  showLabel = true,
  size = "sm",
}: {
  assessment: ReliabilityAssessment;
  showLabel?: boolean;
  size?: "sm" | "md";
}) {
  const padding = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border font-medium",
        RATING_STYLES[assessment.rating],
        padding,
      )}
      data-testid={`reliability-badge-${assessment.rating.toLowerCase()}`}
    >
      {assessment.rating}
    </span>
  );
}

export function VerdictPill({
  verdict,
  showLabel = true,
  size = "sm",
}: {
  verdict: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}) {
  const padding = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded font-medium",
        VERDICT_STYLES[verdict] ?? "text-muted-foreground",
        padding,
      )}
      data-testid={`verdict-pill-${verdict.toLowerCase().replace(/[^a-z]/g, "-")}`}
    >
      <VerdictIcon verdict={verdict} />
      {showLabel && verdict}
    </span>
  );
}
