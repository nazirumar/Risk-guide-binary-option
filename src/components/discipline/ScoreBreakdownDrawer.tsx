"use client";

/**
 * Phase 21 — Score breakdown drawer.
 *
 * Renders the per-rule breakdown of a day's score in a Radix Sheet that
 * slides in from the right. For each rule, shows:
 *   - Rule name + earned/total points.
 *   - Plain-language reason (what cost points / what earned them).
 *   - "View trades" link for rules where tradeIds are available (RISK_PER_TRADE,
 *     FOLLOWED_PLAN) — links to /app/trades?strategyId=&date=...
 *
 * The drawer is a Sheet (mobile-friendly bottom sheet on small screens,
 * right-side drawer on desktop) — matches the Phase 5 TradeDetailDrawer pattern.
 */
import Link from "next/link";
import { ShieldCheck, ShieldX, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { DisciplineRuleBreakdown } from "@/lib/behavior/discipline";

function ruleIcon(earned: number, total: number) {
  // Compare against the entry's own total — AVOID_OVERRIDES carries a
  // per-user weight that can differ from the base constant (Phase 29).
  const fullEarned = earned === total && total > 0;
  if (fullEarned) return <CheckCircle2 className="size-4 text-profit" aria-hidden="true" />;
  if (total === 0) return <ShieldX className="size-4 text-muted-foreground" aria-hidden="true" />;
  return <ShieldX className="size-4 text-loss" aria-hidden="true" />;
}

export function ScoreBreakdownDrawer({
  open,
  onOpenChange,
  date,
  score,
  isRestDay,
  breakdown,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  date: string;
  score: number;
  isRestDay: boolean;
  breakdown: DisciplineRuleBreakdown[];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full sm:max-w-md overflow-y-auto"
        data-testid="score-breakdown-drawer"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" aria-hidden="true" />
            Discipline breakdown · {date}
          </SheetTitle>
          <SheetDescription>
            Score: <span className="font-bold text-foreground">{score}/100</span>
            {isRestDay && (
              <span className="ml-2 text-[11px] text-muted-foreground">
                · rest day (kept the streak)
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3" data-testid="breakdown-rules">
          {breakdown.map((b) => (
            <div
              key={b.rule}
              className="rounded-md border border-border p-3 space-y-1"
              data-testid={`breakdown-rule-${b.rule.toLowerCase()}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {ruleIcon(b.earned, b.total)}
                  {b.rule
                    .split("_")
                    .map((w) => w[0] + w.slice(1).toLowerCase())
                    .join(" ")}
                </div>
                <div className="text-xs tabular-nums">
                  <span className={b.earned === b.total ? "text-profit" : "text-loss"}>
                    {b.earned}
                  </span>
                  <span className="text-muted-foreground">/{b.total}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{b.reason}</p>
              {b.tradeIds && b.tradeIds.length > 0 && (
                <Link
                  href={`/app/trades?date=${date}`}
                  className="inline-flex items-center gap-1 mt-1 text-xs text-primary hover:underline"
                  data-testid={`breakdown-view-trades-${b.rule.toLowerCase()}`}
                >
                  <ShieldCheck className="size-3" aria-hidden="true" />
                  View {b.tradeIds.length} responsible trade
                  {b.tradeIds.length === 1 ? "" : "s"}
                </Link>
              )}
            </div>
          ))}
        </div>

        <p className="mt-4 text-[10px] text-muted-foreground">
          This score describes your rules adherence on {date}. It does not predict future
          performance — past results don&apos;t guarantee future outcomes.
        </p>
      </SheetContent>
    </Sheet>
  );
}
