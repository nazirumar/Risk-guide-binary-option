/**
 * Common trading assets for the asset combobox (PROJECT_RULES.md Phase 5 spec:
 * "common pairs and OTC pairs, free text allowed").
 *
 * The combobox always allows free text — these are just suggestions that
 * match quickly. Phase 12 will let users add custom assets to their
 * per-user list.
 */
export type AssetCategory =
  "FX Major" | "FX Minor" | "FX Exotic" | "OTC" | "Crypto" | "Commodity" | "Index";

export type AssetDef = {
  symbol: string;
  label: string;
  category: AssetCategory;
};

export const COMMON_ASSETS: AssetDef[] = [
  // FX Majors
  { symbol: "EUR/USD", label: "EUR/USD — Euro / US Dollar", category: "FX Major" },
  { symbol: "GBP/USD", label: "GBP/USD — Pound / US Dollar", category: "FX Major" },
  { symbol: "USD/JPY", label: "USD/JPY — Dollar / Yen", category: "FX Major" },
  { symbol: "USD/CHF", label: "USD/CHF — Dollar / Swiss Franc", category: "FX Major" },
  { symbol: "AUD/USD", label: "AUD/USD — Aussie / US Dollar", category: "FX Major" },
  { symbol: "USD/CAD", label: "USD/CAD — Dollar / Loonie", category: "FX Major" },
  { symbol: "NZD/USD", label: "NZD/USD — Kiwi / US Dollar", category: "FX Major" },
  // FX Minors / Crosses
  { symbol: "EUR/GBP", label: "EUR/GBP — Euro / Pound", category: "FX Minor" },
  { symbol: "EUR/JPY", label: "EUR/JPY — Euro / Yen", category: "FX Minor" },
  { symbol: "GBP/JPY", label: "GBP/JPY — Pound / Yen", category: "FX Minor" },
  { symbol: "AUD/JPY", label: "AUD/JPY — Aussie / Yen", category: "FX Minor" },
  { symbol: "EUR/AUD", label: "EUR/AUD — Euro / Aussie", category: "FX Minor" },
  { symbol: "GBP/AUD", label: "GBP/AUD — Pound / Aussie", category: "FX Minor" },
  // FX Exotics
  { symbol: "USD/TRY", label: "USD/TRY — Dollar / Lira", category: "FX Exotic" },
  { symbol: "USD/ZAR", label: "USD/ZAR — Dollar / Rand", category: "FX Exotic" },
  { symbol: "USD/MXN", label: "USD/MXN — Dollar / Peso", category: "FX Exotic" },
  { symbol: "EUR/TRY", label: "EUR/TRY — Euro / Lira", category: "FX Exotic" },
  // OTC pairs (popular with binary options brokers)
  { symbol: "EUR/USD OTC", label: "EUR/USD OTC (weekend)", category: "OTC" },
  { symbol: "GBP/USD OTC", label: "GBP/USD OTC (weekend)", category: "OTC" },
  { symbol: "USD/JPY OTC", label: "USD/JPY OTC (weekend)", category: "OTC" },
  { symbol: "AUD/CAD OTC", label: "AUD/CAD OTC (weekend)", category: "OTC" },
  { symbol: "EUR/GBP OTC", label: "EUR/GBP OTC (weekend)", category: "OTC" },
  { symbol: "USD/CHF OTC", label: "USD/CHF OTC (weekend)", category: "OTC" },
  // Crypto
  { symbol: "BTC/USD", label: "BTC/USD — Bitcoin", category: "Crypto" },
  { symbol: "ETH/USD", label: "ETH/USD — Ethereum", category: "Crypto" },
  { symbol: "LTC/USD", label: "LTC/USD — Litecoin", category: "Crypto" },
  { symbol: "XRP/USD", label: "XRP/USD — Ripple", category: "Crypto" },
  { symbol: "BNB/USD", label: "BNB/USD — Binance Coin", category: "Crypto" },
  // Commodities
  { symbol: "XAU/USD", label: "XAU/USD — Gold", category: "Commodity" },
  { symbol: "XAG/USD", label: "XAG/USD — Silver", category: "Commodity" },
  { symbol: "WTI/USD", label: "WTI/USD — Crude Oil", category: "Commodity" },
  { symbol: "BRENT/USD", label: "BRENT/USD — Brent Oil", category: "Commodity" },
  { symbol: "NATGAS/USD", label: "NATGAS/USD — Natural Gas", category: "Commodity" },
  // Indices
  { symbol: "SPX500", label: "S&P 500 Index", category: "Index" },
  { symbol: "NAS100", label: "Nasdaq 100", category: "Index" },
  { symbol: "US30", label: "Dow Jones 30", category: "Index" },
  { symbol: "GER40", label: "DAX 40 (Germany)", category: "Index" },
  { symbol: "UK100", label: "FTSE 100 (UK)", category: "Index" },
  { symbol: "JPN225", label: "Nikkei 225 (Japan)", category: "Index" },
];

export const ASSET_CATEGORIES: AssetCategory[] = [
  "FX Major",
  "FX Minor",
  "FX Exotic",
  "OTC",
  "Crypto",
  "Commodity",
  "Index",
];

/**
 * Search the COMMON_ASSETS list by symbol or label (case-insensitive).
 * Returns matches + their category — caller decides how to render groups.
 */
export function searchAssets(query: string, limit = 20): AssetDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMON_ASSETS.slice(0, limit);
  return COMMON_ASSETS.filter(
    (a) =>
      a.symbol.toLowerCase().includes(q) ||
      a.label.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q),
  ).slice(0, limit);
}
