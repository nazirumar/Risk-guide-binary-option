import { formatMoney, formatDate, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

type TiltHistoryData = {
  totalEvents: number;
  tiltEvents: { score: number; level: string; createdAt: string }[];
  tiltPL: number;
  calmPL: number;
};

/**
 * TiltHistoryCard — shows the count of tilt events per week and the P/L
 * of trades taken while in TILT vs CALM.
 */
export function TiltHistoryCard({ data }: { data: TiltHistoryData }) {
  if (data.totalEvents === 0) {
    return (
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold mb-2">Tilt history</h3>
        <p className="text-sm text-muted-foreground">No tilt events recorded. Good discipline!</p>
      </div>
    );
  }

  const tiltBetterThanCalm = data.tiltPL > data.calmPL;

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold">Tilt history</h3>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-md bg-muted/40 p-2 text-center">
          <div className="text-xs text-muted-foreground">Tilt events</div>
          <div className="text-xl font-bold tabular-nums">{data.totalEvents}</div>
        </div>
        <div
          className={`rounded-md p-2 text-center ${data.tiltPL >= 0 ? "bg-profit/10" : "bg-loss/10"}`}
        >
          <div className="text-xs text-muted-foreground">P/L while tilted</div>
          <div
            className={`text-lg font-bold tabular-nums ${data.tiltPL >= 0 ? "text-profit" : "text-loss"}`}
          >
            {data.tiltPL >= 0 ? "+" : ""}
            {data.tiltPL.toFixed(2)}
          </div>
        </div>
        <div
          className={`rounded-md p-2 text-center ${data.calmPL >= 0 ? "bg-profit/10" : "bg-loss/10"}`}
        >
          <div className="text-xs text-muted-foreground">P/L while calm</div>
          <div
            className={`text-lg font-bold tabular-nums ${data.calmPL >= 0 ? "text-profit" : "text-loss"}`}
          >
            {data.calmPL >= 0 ? "+" : ""}
            {data.calmPL.toFixed(2)}
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {tiltBetterThanCalm
          ? "Interesting — you performed BETTER while tilted. This is unusual and may not be sustainable."
          : "Your performance while tilted is worse than when calm. Taking breaks after losses protects your bankroll."}
      </p>

      {data.tiltEvents.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">Recent events</h4>
          {data.tiltEvents.slice(0, 5).map((e, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span
                className={cn(
                  e.level === "TILT" ? "text-loss" : "text-amber-600 dark:text-amber-400",
                )}
              >
                {e.level}
              </span>
              <span className="tabular-nums text-muted-foreground">score {e.score}</span>
              <span className="text-muted-foreground">
                {formatDate(e.createdAt, { withTime: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
