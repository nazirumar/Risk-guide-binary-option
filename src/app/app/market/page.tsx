import { requireUser } from "@/server/lib/require-user";
import { buildMarketSnapshot, getFavoriteInstrumentIds } from "@/server/lib/market-snapshot";
import { MarketDashboard } from "@/components/market/MarketDashboard";

/**
 * Phase 28 — `/app/market` live market conditions dashboard (server shell).
 *
 * (rule #3: favorites are user-scoped; the snapshot rows themselves are global
 * market data. rule #11: the page carries the persistent disclaimer.)
 *
 * The server renders the FIRST snapshot (fast paint, no client waterfall) and
 * hands it to the client, which keeps it fresh over SSE.
 */
export default async function MarketPage() {
  const user = await requireUser();
  const [initial, favorites] = await Promise.all([
    buildMarketSnapshot(),
    getFavoriteInstrumentIds(user.userId),
  ]);

  return <MarketDashboard initial={initial} initialFavorites={favorites} />;
}
