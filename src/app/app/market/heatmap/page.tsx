import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { getHeatmapAction } from "@/server/actions/market-conditions";
import { HeatmapGrid } from "@/components/market/HeatmapGrid";
import { EmptyState } from "@/components/trader/EmptyState";
import { Grid3x3 } from "lucide-react";

/**
 * /app/market/heatmap — Phase 27 volatility heatmap.
 *
 * Server Component. Renders the weekday × hour ATR% grid for a selected pair,
 * with a UTC / user-timezone toggle, a color scale, tooltips showing sample
 * size, and a "typically active windows" summary.
 *
 * Wording (spec): copy uses "higher volatility" / "typically active" — never
 * "best time to trade". Cells with < 10 sample days show "not enough data".
 *
 * PROJECT_RULES.md rule #3: the page requires a session; market rows are
 * global (no userId) so no user-scoped filter applies here.
 */
export default async function MarketHeatmapPage() {
  const { timezone } = await requireUser();
  const tz = timezone || "UTC";

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    orderBy: { symbol: "asc" },
    select: { symbol: true },
  });

  if (instruments.length === 0) {
    return (
      <div className="space-y-6">
        <Header tz={tz} />
        <EmptyState
          icon={Grid3x3}
          title="No instruments yet"
          description="The volatility heatmap needs at least one instrument with stored candles. Run the market-data worker to backfill candles, then recompute the heatmap."
        />
      </div>
    );
  }

  const defaultPair = instruments[0].symbol;
  const heatmap = await getHeatmapAction(defaultPair);

  return (
    <div className="space-y-6">
      <Header tz={tz} />

      <div
        className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground"
        data-testid="heatmap-disclaimer"
      >
        <strong className="text-foreground">Note.</strong> This heatmap is descriptive of stored
        historical candles (ATR% by weekday and hour). It shows where volatility has typically been
        higher — it is not a recommendation of when to trade, and past behaviour does not predict
        future markets.
      </div>

      <HeatmapGrid
        instruments={instruments}
        initialPair={defaultPair}
        userTz={tz}
        initialData={heatmap}
      />
    </div>
  );
}

function Header({ tz }: { tz: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Volatility heatmap</h1>
      <p className="text-sm text-muted-foreground">
        ATR% by weekday × hour · default {tz} · toggle to UTC in the controls
      </p>
    </div>
  );
}
