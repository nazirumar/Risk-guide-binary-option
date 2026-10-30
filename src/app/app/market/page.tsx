"use client";

import { useState } from "react";
import { MarketDashboard } from "@/components/market/MarketDashboard";
import { TradeNowFilter } from "@/components/market/TradeNowFilter";
import { SessionIndicator } from "@/components/market/SessionIndicator";
import { BestForSession } from "@/components/market/BestForSession";

export default function MarketPage() {
  const [tradeNowOnly, setTradeNowOnly] = useState(false);
  const favorites: string[] = [];
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

  return (
    <div className="space-y-4">
      <SessionIndicator />
      <BestForSession />
      <TradeNowFilter onFilterChange={(f) => setTradeNowOnly(f.tradeNowOnly)} />
      <MarketDashboard initial={initial} initialFavorites={favorites} tradeNowOnly={tradeNowOnly} />
    </div>
  );
}
