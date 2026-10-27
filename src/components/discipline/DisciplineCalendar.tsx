"use client";

/**
 * Phase 21 — Discipline calendar (client component).
 *
 * Renders a 6-week calendar grid colored by daily score. Clicking a day
 * opens the breakdown drawer (the parent passes the onDayClick handler).
 *
 * Each cell color: green ≥ 80, amber 60-79, red < 60, muted for rest days
 * (treated as neutral — green-ish), outlined for "today".
 *
 * The component receives a list of {date, score, isRestDay} entries and a
 * `monthKey` (YYYY-MM) to display.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DailyScoreEntry } from "@/lib/behavior/discipline";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scoreClass(score: number, isRestDay: boolean): string {
  if (isRestDay) return "bg-muted/60 text-muted-foreground"; // rest day = neutral muted
  if (score >= 80) return "bg-profit/20 text-profit hover:bg-profit/30";
  if (score >= 60) return "bg-warning/20 text-warning hover:bg-warning/30";
  return "bg-loss/20 text-loss hover:bg-loss/30";
}

function dayKeyFromDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function DisciplineCalendar({
  monthKey,
  entries,
  onPrev,
  onNext,
  onDayClick,
  selectedDate,
}: {
  monthKey: string; // "YYYY-MM"
  entries: DailyScoreEntry[];
  onPrev: () => void;
  onNext: () => void;
  onDayClick: (date: string) => void;
  selectedDate?: string | null;
}) {
  const [year, month] = monthKey.split("-").map(Number);
  // Build the grid: 6 weeks × 7 days = 42 cells. Start from the Monday on
  // or before the 1st of the month.
  const firstOfMonth = new Date(year, month - 1, 1);
  const firstDayOfWeek = firstOfMonth.getDay(); // 0=Sun
  const offsetFromMonday = (firstDayOfWeek + 6) % 7; // Mon=0 ... Sun=6
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(firstOfMonth.getDate() - offsetFromMonday);

  const cells: { date: Date; key: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({
      date: d,
      key: dayKeyFromDate(d),
      inMonth: d.getMonth() === month - 1,
    });
  }

  const byDate = new Map(entries.map((e) => [e.date, e]));
  const today = dayKeyFromDate(new Date());

  return (
    <div className="rounded-lg border border-border p-4" data-testid="discipline-calendar">
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onPrev}
          className="inline-flex items-center gap-1 h-8 px-2 rounded text-xs font-medium text-muted-foreground hover:bg-accent"
          aria-label="Previous month"
          data-testid="calendar-prev"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Prev
        </button>
        <h2 className="text-sm font-semibold">
          {firstOfMonth.toLocaleString("en-US", { month: "long", year: "numeric" })}
        </h2>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-1 h-8 px-2 rounded text-xs font-medium text-muted-foreground hover:bg-accent"
          aria-label="Next month"
          data-testid="calendar-next"
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] uppercase tracking-wide text-muted-foreground font-medium"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const entry = byDate.get(cell.key);
          const score = entry?.score;
          const isRestDay = entry?.isRestDay ?? false;
          const isToday = cell.key === today;
          const isSelected = selectedDate === cell.key;
          const hasScore = score != null;
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onDayClick(cell.key)}
              disabled={!cell.inMonth}
              className={cn(
                "aspect-square rounded-md flex flex-col items-center justify-center text-xs tabular-nums border",
                cell.inMonth ? scoreClass(score ?? 0, isRestDay && cell.inMonth) : "opacity-30",
                isToday && "ring-2 ring-primary ring-offset-1",
                isSelected && "ring-2 ring-info",
                !hasScore && cell.inMonth && !isRestDay && "bg-muted/20 text-muted-foreground",
              )}
              data-testid={`calendar-cell-${cell.key}`}
              aria-label={`${cell.key}${hasScore ? `: score ${score}${isRestDay ? " (rest day)" : ""}` : ""}`}
            >
              <span className="font-medium">{cell.date.getDate()}</span>
              {hasScore && !isRestDay && <span className="text-[10px] opacity-80">{score}</span>}
              {isRestDay && cell.inMonth && <span className="text-[9px] opacity-70">rest</span>}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-end gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-profit/40" aria-hidden="true" /> ≥ 80
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-warning/40" aria-hidden="true" /> 60–79
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-loss/40" aria-hidden="true" /> &lt; 60
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-muted/60" aria-hidden="true" /> rest
        </span>
      </div>
    </div>
  );
}
