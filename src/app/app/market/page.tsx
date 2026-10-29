import { requireUser } from "@/server/lib/require-user";
import { getFavoriteInstrumentIds } from "@/server/lib/market-snapshot";
import { MarketDashboard } from "@/components/market/MarketDashboard";

export default async function MarketPage() {
  const user = await requireUser();
  const favorites = await getFavoriteInstrumentIds(user.userId);
  const initial = {
    serverTime: new Date().toISOString(),
    isStale: true,
    dataAgeSeconds: null,
    provider: null,
    providerLagSeconds: null,
    providerLastError: null,
    marketClosed: false,
    pairs: [],
    nextNews: null,
  };

  return <MarketDashboard initial={initial} initialFavorites={favorites} />;
}
