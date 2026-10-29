"use server";

/**
 * Phase 28 — Live market snapshot server action.
 *
 * (rule #3: market rows are global; this action is only called from authed
 * client components. rule #11: descriptive wording only.)
 *
 * Used by (a) the 30-second polling FALLBACK when SSE fails, and (b) the
 * "Market now" dashboard widget's initial client-side hydrate/refresh.
 */
import { buildMarketSnapshot, type MarketSnapshot } from "@/server/lib/market-snapshot";
import { requireUser } from "@/server/lib/require-user";

export async function getMarketSnapshotAction(): Promise<MarketSnapshot> {
  await requireUser();
  return buildMarketSnapshot();
}
