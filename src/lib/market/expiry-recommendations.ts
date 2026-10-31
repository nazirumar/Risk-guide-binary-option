export function getRecommendedExpiry(
  session?: string,
  volatilityPercentile?: number | null
): { expiry: number; reason: string } {
  const s = session || "LONDON";
  
  // High volatility or overlap sessions - shorter expiries
  if (s === "LONDON_NY_OVERLAP" || (volatilityPercentile && volatilityPercentile > 80)) {
    return { expiry: 1, reason: "High volatility/overlap - 1 min for quick moves" };
  }
  
  if (s === "LONDON" || s === "NEW_YORK") {
    return { expiry: 3, reason: "Active session - 3 min balanced expiry" };
  }
  
  if (s === "ASIAN") {
    return { expiry: 5, reason: "Range-bound session - 5 min to allow setup to develop" };
  }
  
  if (s === "OFF_HOURS") {
    return { expiry: 5, reason: "Lower liquidity - longer expiry recommended" };
  }
  
  return { expiry: 1, reason: "Default - 1 min expiry" };
}
