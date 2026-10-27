/**
 * Phase 21 — Discipline Score dashboard card.
 *
 * Server Component. Pulls today's score + streak stats via the
 * `getStreakStatsAction` server action and renders:
 *   - Today's score (0–100) with a color (green ≥ 80, amber 60-79, red < 60).
 *   - 7-day average + 30-day average.
 *   - Current disciplined-day streak + best streak.
 *   - Link to /app/discipline for the calendar view + breakdown drawer.
 *
 * Honors rule #11 (visible risk disclaimer) — the card includes a small
 * note that the score is descriptive, not predictive.
 */
import Link from "next/link";
import { Trophy, TrendingUp, Flame } from "lucide-react";
import { getStreakStatsAction } from "@/server/actions/discipline";

function scoreColor(score: number | null | undefined): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-profit";
  if (score >= 60) return "text-warning";
  return "text-loss";
}

export async function DisciplineScoreCard() {
  const stats = await getStreakStatsAction();
  if (!stats.ok) return null;

  const todayScore = stats.todayScore ?? null;
  const todayIsRestDay = stats.todayIsRestDay ?? false;

  return (
    <Link
      href="/app/discipline"
      className="block rounded-lg border border-border p-4 hover:bg-accent/30 transition-colors"
      data-testid="discipline-score-card"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Discipline score
        </h2>
        <Trophy className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {/* Today's score */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            Today
          </div>
          <div
            className={`text-2xl font-bold tabular-nums ${scoreColor(todayScore)}`}
            data-testid="today-discipline-score"
          >
            {todayScore == null ? "—" : todayScore}
            {todayIsRestDay && (
              <span className="text-[10px] font-normal text-muted-foreground ml-1">rest</span>
            )}
          </div>
        </div>
        {/* Current streak */}
        <div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            <Flame className="size-3" aria-hidden="true" />
            Streak
          </div>
          <div className="text-2xl font-bold tabular-nums text-profit" data-testid="current-streak">
            {stats.currentStreak ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">best: {stats.bestStreak ?? 0}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-[10px] text-muted-foreground">
        <div>
          <span className="text-muted-foreground">7-day avg:</span>{" "}
          <span className="font-medium tabular-nums text-foreground" data-testid="seven-day-avg">
            {stats.sevenDayAverage == null ? "—" : stats.sevenDayAverage}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">30-day avg:</span>{" "}
          <span className="font-medium tabular-nums text-foreground" data-testid="thirty-day-avg">
            {stats.thirtyDayAverage == null ? "—" : stats.thirtyDayAverage}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        A descriptive measure of your rules adherence — not a prediction of future performance.
      </p>
    </Link>
  );
}
