import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import {
  getSessionAnalysisAction,
  getHourlyAnalysisAction,
} from "@/server/actions/market-sessions";
import { SESSION_DEFINITIONS, type SessionKey } from "@/lib/news/sessions";
import { EmptyState } from "@/components/trader/EmptyState";
import { StatCard } from "@/components/trader/StatCard";
import { TrendingUp, Clock } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { SuggestTradingHoursButton } from "@/components/sessions/SuggestTradingHoursButton";

/**
 * /app/sessions — Phase 22 Market-session analysis.
 *
 * Server Component. Layout:
 *   - Header + past-results disclaimer.
 *   - Per-session stats table (win rate, P/L, expectancy).
 *   - Per-hour heatmap (in user TZ) with best/worst hour highlights.
 *   - Suggest trading hours button (calls suggestTradingHoursAction).
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 */
export default async function SessionsPage() {
  const { userId, timezone } = await requireUser();
  const tz = timezone || "UTC";

  const [sessionResult, hourlyResult] = await Promise.all([
    getSessionAnalysisAction(),
    getHourlyAnalysisAction(),
  ]);

  const sessions = sessionResult.sessions ?? [];
  const hours = hourlyResult.hours ?? [];
  const bestHour = hourlyResult.bestHour ?? null;
  const worstHour = hourlyResult.worstHour ?? null;
  const suggestion = hourlyResult.suggestedTradingHours ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sessions & Hours</h1>
          <p className="text-sm text-muted-foreground">
            Per-session + per-hour analysis · {tz} · {sessionResult.totalTrades ?? 0} trades
          </p>
        </div>
        <SuggestTradingHoursButton initialSuggestion={suggestion} />
      </div>

      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="sessions-disclaimer"
      >
        <strong className="text-foreground">Disclaimer.</strong> Session classifications use
        DST-aware UTC boundaries (Asia year-round; London + NY shift by 1 hour in summer). The
        analysis is descriptive of historical trades — past performance does not guarantee future
        results.
      </div>

      {/* Per-session table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">By session</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="sessions-table">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Session</th>
                <th className="px-4 py-2.5 text-right">Trades</th>
                <th className="px-4 py-2.5 text-right">Win rate</th>
                <th className="px-4 py-2.5 text-right">Net P/L</th>
                <th className="px-4 py-2.5 text-right">Expectancy / trade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map((s) => (
                <tr key={s.session} data-testid={`session-row-${s.session}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-3 rounded-sm shrink-0"
                        style={{ backgroundColor: s.color }}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="font-medium">{s.label}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {SESSION_DEFINITIONS[s.session as SessionKey]?.description ?? ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.trades}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.trades === 0 ? "—" : `${(s.winRate * 100).toFixed(1)}%`}
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums ${s.netPL >= 0 ? "text-profit" : "text-loss"}`}
                  >
                    {s.trades === 0 ? "—" : formatMoney(s.netPL, "USD", { signed: true })}
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums ${s.expectancyPerTrade >= 0 ? "text-profit" : "text-loss"}`}
                  >
                    {s.trades === 0
                      ? "—"
                      : formatMoney(s.expectancyPerTrade, "USD", { signed: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Best + worst hour stat cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Best hour"
          value={bestHour ? `${String(bestHour.hour).padStart(2, "0")}:00` : "—"}
          delta={
            bestHour
              ? `${bestHour.trades} trade${bestHour.trades === 1 ? "" : "s"}, exp ${formatMoney(bestHour.expectancyPerTrade, "USD", { signed: true })}/trade`
              : "Need ≥3 trades/hour to qualify"
          }
          trend="up"
          icon={TrendingUp}
        />
        <StatCard
          label="Worst hour"
          value={worstHour ? `${String(worstHour.hour).padStart(2, "0")}:00` : "—"}
          delta={
            worstHour
              ? `${worstHour.trades} trade${worstHour.trades === 1 ? "" : "s"}, exp ${formatMoney(worstHour.expectancyPerTrade, "USD", { signed: true })}/trade`
              : "Need ≥3 trades/hour to qualify"
          }
          trend="down"
          icon={Clock}
        />
      </div>

      {/* Per-hour heatmap (in user TZ) */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Hourly win rate · {tz}</h2>
          <p className="text-xs text-muted-foreground">
            Color intensity = win rate · number = trades
          </p>
        </div>
        <div className="grid grid-cols-6 sm:grid-cols-12 gap-1" data-testid="hourly-heatmap">
          {hours.map((h) => {
            const isBest = bestHour?.hour === h.hour;
            const isWorst = worstHour?.hour === h.hour;
            const winPct = h.trades > 0 ? h.winRate * 100 : 0;
            // Background: green for high win rate, red for low, muted for 0 trades.
            const bgClass =
              h.trades === 0
                ? "bg-muted/30 text-muted-foreground"
                : winPct >= 60
                  ? "bg-profit/30 text-profit"
                  : winPct >= 40
                    ? "bg-warning/30 text-warning"
                    : "bg-loss/30 text-loss";
            return (
              <div
                key={h.hour}
                className={`rounded-md p-1.5 text-center text-xs ${bgClass} ${isBest ? "ring-2 ring-profit" : ""} ${isWorst ? "ring-2 ring-loss" : ""}`}
                data-testid={`hour-cell-${h.hour}`}
                title={`${String(h.hour).padStart(2, "0")}:00 — ${h.trades} trades, ${(h.winRate * 100).toFixed(0)}% win, exp ${h.expectancyPerTrade}/trade`}
              >
                <div className="font-medium">{String(h.hour).padStart(2, "0")}</div>
                <div className="text-[10px] opacity-80">{h.trades}</div>
              </div>
            );
          })}
        </div>
      </div>

      {sessionResult.totalTrades === 0 && (
        <EmptyState
          icon={Clock}
          title="No trades yet"
          description="Session + hourly analysis populates as you log trades under any account. Trades are classified by their UTC open time into Asian / London / New York / overlap sessions."
          actionLabel="Add trade"
          actionHref="/app/trades"
        />
      )}
    </div>
  );
}
