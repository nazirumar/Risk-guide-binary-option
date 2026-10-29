"use client";

/**
 * Phase 28 — Rating badge + score/volatility bars.
 *
 * (rule #11: GOOD/CAUTION/AVOID are descriptive market-condition labels, never
 * advice. During an outage the badge is NOT rendered and values go grey.)
 */
import type { Rating } from "@/server/lib/market-snapshot";

const RATING_STYLES: Record<Rating, { label: string; className: string }> = {
  GOOD: { label: "GOOD", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  CAUTION: { label: "CAUTION", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  AVOID: { label: "AVOID", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
};

export function RatingBadge({ rating, muted }: { rating: Rating; muted?: boolean }) {
  if (muted) {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        —
      </span>
    );
  }
  const s = RATING_STYLES[rating];
  return (
    <span
      data-testid="rating-badge"
      data-rating={rating}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}

/** A 0-100 horizontal bar (score or volatility percentile). */
export function ScoreBar({
  value,
  max = 100,
  label,
  muted,
}: {
  value: number | null;
  max?: number;
  label: string;
  muted?: boolean;
}) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={label}
      >
        <div
          data-testid="score-bar-fill"
          className={`h-full rounded-full ${muted ? "bg-muted-foreground/30" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {value == null ? "—" : Math.round(value)}
      </span>
    </div>
  );
}
