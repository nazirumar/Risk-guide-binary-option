import Link from "next/link";
import { Trophy, TrendingUp } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import {
  getStreakStatsAction,
  getScoreHistoryAction,
  computeDailyScoreAction,
} from "@/server/actions/discipline";
import { shiftDayKey, dayKeyInTz, type DailyScoreEntry } from "@/lib/behavior/discipline";
import { DisciplineCalendarClient } from "@/components/discipline/DisciplineCalendarClient";
import {
  DisciplineVsProfitChart,
  type WeeklyDisciplineVsProfitPoint,
} from "@/components/discipline/DisciplineVsProfitChart";
import { MilestoneBadges } from "@/components/discipline/MilestoneBadges";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import Decimal from "decimal.js";

/**
 * /app/discipline — Phase 21 Discipline Score detail page.
 *
 * Server Component. Layout:
 *   - Header (today's score + current streak + best streak).
 *   - Stat grid (today / 7-day avg / 30-day avg / current streak).
 *   - Milestone badges (7 / 30 / 100 days).
 *   - Calendar view colored by score (click a day → breakdown drawer).
 *   - Weekly "discipline vs profit" chart.
 *   - Disclaimer block (rule #11).
 *
 * Accepts `?month=YYYY-MM` to scope the calendar to a specific month.
 * Accepts `?day=YYYY-MM-DD` to pre-select a day (open the breakdown drawer).
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 */
export default async function DisciplinePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; day?: string }>;
}) {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";
  const sp = await searchParams;
  const now = new Date();
  const todayKey = dayKeyInTz(now, tz);
  const monthKey = sp.month ?? todayKey.slice(0, 7); // "YYYY-MM"
  const preselectedDay = sp.day ?? null;

  // 1. Ensure today's score exists (compute on demand if missing/stale).
  await computeDailyScoreAction(todayKey);

  // 2. Fetch streak stats (today's score, current/best streak, 7d/30d avg).
  const stats = await getStreakStatsAction();

  // 3. Fetch the calendar month's DailyScore rows + adjacent days for the
  // grid (the calendar grid spans 6 weeks = 42 days, so we fetch a slightly
  // wider range).
  const [yyyy, mm] = monthKey.split("-").map(Number);
  const monthStart = new Date(Date.UTC(yyyy, mm - 1, 1));
  // Walk back to the Monday on or before the 1st of the month.
  const firstDayOfWeek = monthStart.getDay();
  const offsetFromMonday = (firstDayOfWeek + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(monthStart.getUTCDate() - offsetFromMonday);
  const gridStartKey = gridStart.toISOString().slice(0, 10);
  const gridEnd = new Date(gridStart);
  gridEnd.setUTCDate(gridStart.getUTCDate() + 41);
  const gridEndKey = gridEnd.toISOString().slice(0, 10);

  const historyResult = await getScoreHistoryAction({
    fromKey: gridStartKey,
    toKey: gridEndKey,
  });
  const entries: DailyScoreEntry[] = (historyResult.rows ?? []).map((r) => ({
    date: r.date,
    score: r.score,
    isRestDay: r.isRestDay,
  }));

  // 4. Build the weekly discipline-vs-profit chart data. Walk back ~8 weeks
  // from today (in user TZ). For each week, fetch that week's DailyScores +
  // that week's trades' net P/L.
  const weeklyData: WeeklyDisciplineVsProfitPoint[] = [];
  for (let w = 7; w >= 0; w--) {
    const weekEnd = shiftDayKey(todayKey, -w * 7);
    const weekStart = shiftDayKey(weekEnd, -6);
    // Fetch DailyScore rows for the week.
    const weekRows = await db.dailyScore.findMany({
      where: {
        userId,
        date: { gte: weekStart, lte: weekEnd },
      },
      select: { score: true, isRestDay: true },
    });
    const avgScore =
      weekRows.length === 0
        ? null
        : Math.round(
            (weekRows.reduce((acc, r) => acc + Number(r.score.toString()), 0) / weekRows.length) *
              10,
          ) / 10;

    // Compute net P/L for the week (trades opened in the user's TZ day range).
    // Convert day keys back to UTC instants.
    const [wy, wm, wd] = weekStart.split("-").map(Number);
    const weekStartUtc = new Date(Date.UTC(wy, wm - 1, wd));
    const tzOffsetMinutes = tzOffsetMinutesFor(tz, weekStartUtc);
    const weekStartInstant = new Date(weekStartUtc.getTime() - tzOffsetMinutes * 60_000);
    const weekEndPlusOneDay = shiftDayKey(weekEnd, 1);
    const [ey, em, ed] = weekEndPlusOneDay.split("-").map(Number);
    const weekEndUtc = new Date(Date.UTC(ey, em - 1, ed));
    const weekEndInstant = new Date(weekEndUtc.getTime() - tzOffsetMinutes * 60_000);

    const weekTrades = await db.trade.findMany({
      where: {
        userId,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: weekStartInstant, lt: weekEndInstant },
      },
      select: { profitLoss: true },
    });
    const netPL = weekTrades.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);

    weeklyData.push({
      weekLabel: `W${8 - w}`,
      avgScore,
      netProfit: Math.round(netPL * 100) / 100,
    });
  }

  const todayScore = stats.todayScore ?? null;
  const todayIsRestDay = stats.todayIsRestDay ?? false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Discipline</h1>
          <p className="text-sm text-muted-foreground">
            Daily discipline score (0–100) · current streak {stats.currentStreak ?? 0} day
            {(stats.currentStreak ?? 0) === 1 ? "" : "s"} · best {stats.bestStreak ?? 0}
          </p>
        </div>
        <MilestoneBadges currentStreak={stats.currentStreak ?? 0} />
      </div>

      {/* Disclaimer */}
      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="discipline-disclaimer"
      >
        <strong className="text-foreground">Disclaimer.</strong> The discipline score is a
        descriptive measure of your rules adherence — it is not a prediction of future performance.
        A high score does not guarantee future profitability; a low score does not guarantee future
        losses. Use this as a discipline aid, not a financial signal.
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Today's score"
          value={todayScore == null ? "—" : String(todayScore)}
          delta={
            todayIsRestDay
              ? "rest day"
              : todayScore != null && todayScore >= 80
                ? "disciplined ✓"
                : "below 80"
          }
          trend={
            todayScore != null && todayScore >= 80 ? "up" : todayScore != null ? "down" : "neutral"
          }
          icon={Trophy}
        />
        <StatCard
          label="7-day average"
          value={stats.sevenDayAverage == null ? "—" : String(stats.sevenDayAverage)}
          delta={`${stats.sevenDayScores?.length ?? 0} days logged`}
          icon={TrendingUp}
        />
        <StatCard
          label="30-day average"
          value={stats.thirtyDayAverage == null ? "—" : String(stats.thirtyDayAverage)}
          delta={`${stats.thirtyDayScores?.length ?? 0} days logged`}
          icon={TrendingUp}
        />
        <StatCard
          label="Current streak"
          value={stats.currentStreak ?? 0}
          delta={`best: ${stats.bestStreak ?? 0}`}
          trend="up"
          icon={Trophy}
        />
      </div>

      {/* Calendar (client component wraps the DisciplineCalendar + drawer) */}
      <DisciplineCalendarClient
        monthKey={monthKey}
        entries={entries}
        initialSelectedDate={preselectedDay}
      />

      {/* Weekly discipline vs profit chart */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Discipline vs profit (last 8 weeks)</h2>
          <p className="text-xs text-muted-foreground">Do disciplined weeks earn more?</p>
        </div>
        <DisciplineVsProfitChart data={weeklyData} />
      </div>

      {/* Empty-state CTA when no scores yet */}
      {entries.length === 0 && (
        <EmptyState
          icon={Trophy}
          title="No discipline history yet"
          description="Your daily scores will populate here as you trade. Days with no trades and no breaches count as rest days — they keep the streak."
          actionLabel="Add trade"
          actionHref="/app/trades"
        />
      )}
    </div>
  );
}

// ─── TZ offset helper (mirror of the action's) ───────────────────────────────

function tzOffsetMinutesFor(tz: string, d: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(d);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const y = Number(map.get("year"));
    const m = Number(map.get("month")) - 1;
    const day = Number(map.get("day"));
    const h = Number(map.get("hour")) === 24 ? 0 : Number(map.get("hour"));
    const min = Number(map.get("minute"));
    const sec = Number(map.get("second"));
    const asUtc = Date.UTC(y, m, day, h, min, sec);
    return Math.round((asUtc - d.getTime()) / 60_000);
  } catch {
    return 0;
  }
}
