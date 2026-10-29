export type FeedResolution = { instrumentId: string | null; isOtc: boolean; reason: string };

export function resolveFeedSymbol(broker: string, assetName: string): FeedResolution {
  const name = assetName.trim().toUpperCase().replace(/\s+/g, " ");
  const isOtc = /OTC/.test(name) || /WEEKEND/.test(name);
  // Normalize
  const cleaned = name.replace(/OTC/g, "").replace(/WEEKEND/g, "").replace(/[()]/g, "").trim();
  const compact = cleaned.replace(/[^A-Z]/g, "");
  // Common majors
  const majors: Record<string, string> = {
    EURUSD: "EUR_USD",
    GBPUSD: "GBP_USD",
    USDJPY: "USD_JPY",
    AUDUSD: "AUD_USD",
    USDCAD: "USD_CAD",
    USDCHF: "USD_CHF",
    NZDUSD: "NZD_USD",
    EURGBP: "EUR_GBP",
    EURJPY: "EUR_JPY",
    GBPJPY: "GBP_JPY",
  };
  if (isOtc) return { instrumentId: null, isOtc: true, reason: "OTC / no market data" };
  const id = majors[compact];
  if (!id) return { instrumentId: null, isOtc: false, reason: "Unmapped instrument" };
  return { instrumentId: id, isOtc: false, reason: "Mapped" };
}
