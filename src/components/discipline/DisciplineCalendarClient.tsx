"use client";

/**
 * Phase 21 — Client wrapper for the DisciplineCalendar + ScoreBreakdownDrawer.
 *
 * Holds the calendar's selected-month + selected-day state (so the user can
 * navigate months + click days without server round-trips). When a day is
 * clicked, fetches the breakdown via the `computeDailyScoreAction` server
 * action (which computes if missing + returns the breakdown) and opens the
 * drawer with the result.
 *
 * Receives the initial month's entries from the Server Component (so the
 * first paint shows data immediately). When the user navigates months, we
 * trigger a `router.push` + `router.refresh()` which re-fetches the new
 * month on the server — simpler than duplicating the fetch logic client-side.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DisciplineCalendar } from "./DisciplineCalendar";
import { ScoreBreakdownDrawer } from "./ScoreBreakdownDrawer";
import { computeDailyScoreAction } from "@/server/actions/discipline";
import { toast } from "@/hooks/use-toast";
import type { DisciplineRuleBreakdown } from "@/lib/behavior/discipline";
import type { DailyScoreEntry } from "@/lib/behavior/discipline";

export function DisciplineCalendarClient({
  monthKey,
  entries,
  initialSelectedDate,
}: {
  monthKey: string;
  entries: DailyScoreEntry[];
  initialSelectedDate?: string | null;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(initialSelectedDate ?? null);
  const [breakdown, setBreakdown] = useState<{
    date: string;
    score: number;
    isRestDay: boolean;
    rules: DisciplineRuleBreakdown[];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Fetch the breakdown for a date on click. The drawer opens with the
  // result; if the fetch fails, we show a toast + clear the selection.
  function onDayClick(date: string) {
    setSelectedDate(date);
    startTransition(async () => {
      const res = await computeDailyScoreAction(date);
      if (!res.ok) {
        toast({
          title: "Couldn't load breakdown",
          description: res.message,
          variant: "destructive",
        });
        setBreakdown(null);
        setSelectedDate(null);
        return;
      }
      setBreakdown({
        date: res.date!,
        score: res.score!,
        isRestDay: res.isRestDay ?? false,
        rules: res.breakdown ?? [],
      });
    });
  }

  function onCloseDrawer() {
    setSelectedDate(null);
    setBreakdown(null);
  }

  function onPrev() {
    const [y, m] = monthKey.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1)); // m-1 is 0-indexed; m-2 is prev month
    const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
    router.push(`/app/discipline?month=${prevKey}`);
    router.refresh();
  }

  function onNext() {
    const [y, m] = monthKey.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1)); // m is next month (0-indexed)
    const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    router.push(`/app/discipline?month=${nextKey}`);
    router.refresh();
  }

  return (
    <>
      <DisciplineCalendar
        monthKey={monthKey}
        entries={entries}
        onPrev={onPrev}
        onNext={onNext}
        onDayClick={onDayClick}
        selectedDate={selectedDate}
      />
      <ScoreBreakdownDrawer
        open={selectedDate !== null && breakdown !== null}
        onOpenChange={(o) => {
          if (!o) onCloseDrawer();
        }}
        date={breakdown?.date ?? ""}
        score={breakdown?.score ?? 0}
        isRestDay={breakdown?.isRestDay ?? false}
        breakdown={breakdown?.rules ?? []}
      />
      {pending && (
        <div className="text-xs text-muted-foreground text-center mt-2">Loading breakdown…</div>
      )}
    </>
  );
}
