"use client";

/**
 * Phase 27 — Market volatility heatmap (client component).
 *
 * Renders a weekday × hour grid of ATR% intensity for a selected pair. The
 * user can switch pairs (re-fetches via `getHeatmapAction`) and toggle between
 * UTC and their own timezone (`regridToTimezone` shifts cells locally).
 *
 * Wording (spec): cells + summaries say "higher volatility" / "typically
 * active" — never "best time to trade". Cells with `sampleDays < 10` render
 * "not enough data" instead of a color.
 *
 * (PROJECT_RULES.md rule #5: accessible — the grid is a real <table> with
 * scope'd headers; each cell carries an aria-label + a hover tooltip with the
 * sample size.)
 */
import { useMemo, useState, useTransition } from "react";
import { Grid3x3, Loader2 } from "lucide-react";

import { getHeatmapAction, type HeatmapResult } from "@/server/actions/market-conditions";
import { regridToTimezone, heatmapColorFor } from "@/lib/market/heatmap";
import { HEATMAP_MIN_SAMPLE_DAYS } from "@/lib/market/scoring-config";
import { toast } from "@/hooks/use-toast";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** ISO weekday 1..7 → 0..6 index into WEEKDAY_LABELS. */
function weekdayIndex(weekday: number): number {
  return weekday - 1;
}

/** Build a blue→amber→red intensity style from a 0..1 value. */
function cellStyle(intensity: number): React.CSSProperties {
  // Hue ramps from 210 (cool blue, quiet) to 0 (red, active).
  const hue = 210 - intensity * 210;
  const light = 22 + intensity * 28;
  return {
    backgroundColor: `hsl(${hue} 80% ${light}%)`,
    color: intensity > 0.55 ? "hsl(0 0% 100%)" : "hsl(0 0% 12%)",
  };
}

export function HeatmapGrid({
  instruments,
  initialPair,
  userTz,
  initialData,
}: {
  instruments: Array<{ symbol: string }>;
  initialPair: string;
  userTz: string;
  initialData: HeatmapResult;
}) {
  const [pair, setPair] = useState(initialPair);
  const [data, setData] = useState<HeatmapResult>(initialData);
  const [useLocalTz, setUseLocalTz] = useState(true);
  const [pending, startTransition] = useTransition();

  function onSelectPair(next: string) {
    if (next === pair) return;
    setPair(next);
    startTransition(async () => {
      const res = await getHeatmapAction(next);
      if (!res.ok) {
        toast({ title: "Couldn't load heatmap", description: res.message, variant: "destructive" });
        return;
      }
      setData(res);
    });
  }

  // Shift UTC cells into the user's timezone when the toggle is on. We derive
  // the offset from a reference instant via Intl (DST-aware for "now").
  const offsetMinutes = useMemo(() => {
    if (!useLocalTz || userTz === "UTC") return 0;
    try {
      const now = new Date();
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: userTz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const parts = dtf.formatToParts(now);
      const map = new Map(parts.map((p) => [p.type, p.value]));
      const asUtc = Date.UTC(
        Number(map.get("year")),
        Number(map.get("month")) - 1,
        Number(map.get("day")),
        Number(map.get("hour") === "24" ? "0" : map.get("hour")),
        Number(map.get("minute")),
        Number(map.get("second")),
      );
      return Math.round((asUtc - now.getTime()) / 60_000);
    } catch {
      return 0;
    }
  }, [useLocalTz, userTz]);

  const displayCells = useMemo(
    () => regridToTimezone(data.cells, offsetMinutes),
    [data, offsetMinutes],
  );
  const displayTop = useMemo(
    () => regridToTimezone(data.topWindows, offsetMinutes),
    [data, offsetMinutes],
  );

  // Grid lookup keyed "weekday:hour".
  const cellMap = useMemo(() => {
    const m = new Map<string, (typeof displayCells)[number]>();
    for (const c of displayCells) m.set(`${c.weekday}:${c.hourUtc}`, c);
    return m;
  }, [displayCells]);

  // Color scale min/max recomputed on the displayed cells (only trusted ones).
  const { minAvg, maxAvg } = useMemo(() => {
    const trusted = displayCells
      .filter((c) => c.sampleDays >= HEATMAP_MIN_SAMPLE_DAYS)
      .map((c) => c.avgAtrPercent);
    if (trusted.length === 0) return { minAvg: 0, maxAvg: 0 };
    return { minAvg: Math.min(...trusted), maxAvg: Math.max(...trusted) };
  }, [displayCells]);

  const tzLabel = useLocalTz && userTz !== "UTC" ? userTz : "UTC";
  const anyTrusted = displayCells.some((c) => c.sampleDays >= HEATMAP_MIN_SAMPLE_DAYS);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="heatmap-pair">
          Pair
        </label>
        <select
          id="heatmap-pair"
          value={pair}
          onChange={(e) => onSelectPair(e.target.value)}
          disabled={pending}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          data-testid="heatmap-pair-select"
        >
          {instruments.map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.symbol.replace("_", "/")}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setUseLocalTz((v) => !v)}
          disabled={pending}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-accent"
          data-testid="heatmap-tz-toggle"
          aria-pressed={useLocalTz}
        >
          <Grid3x3 className="size-3.5" aria-hidden="true" />
          {useLocalTz && userTz !== "UTC" ? `Showing ${userTz}` : "Showing UTC"}
        </button>

        {pending && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse" data-testid="heatmap-grid">
          <caption className="sr-only">
            ATR% volatility by weekday and hour ({tzLabel}) for {pair.replace("_", "/")}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                Day
              </th>
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-1 py-1 text-center font-medium text-muted-foreground"
                >
                  {String(h).padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAY_LABELS.map((dayLabel, di) => {
              const weekday = di + 1;
              return (
                <tr key={dayLabel}>
                  <th scope="row" className="px-2 py-1 text-left font-medium text-muted-foreground">
                    {dayLabel}
                  </th>
                  {Array.from({ length: 24 }, (_, h) => {
                    const cell = cellMap.get(`${weekday}:${h}`);
                    const enough = cell != null && cell.sampleDays >= HEATMAP_MIN_SAMPLE_DAYS;
                    if (!cell) {
                      return (
                        <td key={h} className="p-0.5">
                          <div
                            className="h-8 rounded bg-muted/20 flex items-center justify-center text-[9px] text-muted-foreground"
                            title={`${dayLabel} ${String(h).padStart(2, "0")}:00 — no data`}
                          >
                            —
                          </div>
                        </td>
                      );
                    }
                    if (!enough) {
                      return (
                        <td key={h} className="p-0.5">
                          <div
                            className="h-8 rounded bg-muted/30 flex items-center justify-center text-[8px] text-muted-foreground text-center leading-tight px-0.5"
                            data-testid={`heat-cell-${weekday}-${h}`}
                            title={`${dayLabel} ${String(h).padStart(2, "0")}:00 — not enough data (${cell.sampleDays} day${cell.sampleDays === 1 ? "" : "s"})`}
                            aria-label={`${dayLabel} hour ${h}: not enough data`}
                          >
                            n/a
                          </div>
                        </td>
                      );
                    }
                    const intensity = heatmapColorFor(cell.avgAtrPercent, minAvg, maxAvg);
                    return (
                      <td key={h} className="p-0.5">
                        <div
                          className="h-8 rounded flex items-center justify-center text-[10px] font-medium tabular-nums"
                          style={cellStyle(intensity)}
                          data-testid={`heat-cell-${weekday}-${h}`}
                          title={`${dayLabel} ${String(h).padStart(2, "0")}:00 — avg ATR ${cell.avgAtrPercent.toFixed(3)}%, p20 ${cell.p20.toFixed(3)}%, p80 ${cell.p80.toFixed(3)}%, ${cell.sampleDays} day${cell.sampleDays === 1 ? "" : "s"} of samples`}
                          aria-label={`${dayLabel} hour ${h}: avg ATR ${cell.avgAtrPercent.toFixed(2)} percent over ${cell.sampleDays} days`}
                        >
                          {cell.avgAtrPercent.toFixed(2)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Color scale legend */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>Lower volatility</span>
        <div
          className="h-2 w-32 rounded"
          style={{
            background:
              "linear-gradient(to right, hsl(210 80% 22%), hsl(105 80% 36%), hsl(0 80% 50%))",
          }}
          aria-hidden="true"
        />
        <span>Higher volatility</span>
        <span className="ml-2">· Each cell shows avg ATR% · sample days in tooltip</span>
      </div>

      {/* Typically-active summary */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-1">Most typically active windows</h3>
        {!anyTrusted ? (
          <p className="text-xs text-muted-foreground" data-testid="heatmap-no-data">
            Not enough data — this pair needs at least {HEATMAP_MIN_SAMPLE_DAYS} days of candles per
            weekday-hour before windows can be summarized.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              Ranked by peak (p80) ATR% — these windows historically show higher volatility. This is
              descriptive of past data, not a suggestion of when to trade.
            </p>
            <ul className="space-y-1 text-xs" data-testid="heatmap-top-windows">
              {displayTop.map((w) => (
                <li key={`${w.weekday}-${w.hourUtc}`} className="flex justify-between">
                  <span>
                    {WEEKDAY_LABELS[weekdayIndex(w.weekday)]} {String(w.hourUtc).padStart(2, "0")}
                    :00 {tzLabel}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    p80 {w.p80.toFixed(3)}% · {w.sampleDays} days
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
