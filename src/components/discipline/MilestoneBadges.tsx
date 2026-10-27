/**
 * Phase 21 — Subtle milestone badges.
 *
 * Renders badges for 7 / 30 / 100 disciplined-day milestones. "Earned"
 * badges are slightly emphasized (filled); "next" badges are outlined.
 *
 * The spec asks for them to be "subtle and professional" — no animations,
 * no celebratory copy. Just a small icon + count + label.
 */
import { Award } from "lucide-react";
import { cn } from "@/lib/utils";

const MILESTONES = [7, 30, 100] as const;

export function MilestoneBadges({ currentStreak }: { currentStreak: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="milestone-badges">
      {MILESTONES.map((m) => {
        const earned = currentStreak >= m;
        return (
          <span
            key={m}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border",
              earned
                ? "bg-profit/15 text-profit border-profit/30"
                : "bg-muted/40 text-muted-foreground border-muted-foreground/20",
            )}
            data-testid={`milestone-${m}`}
            title={earned ? `${m}-day milestone earned` : `Next milestone: ${m} days`}
          >
            <Award className="size-3" aria-hidden="true" />
            {m}-day
            {earned && " ✓"}
          </span>
        );
      })}
    </div>
  );
}
