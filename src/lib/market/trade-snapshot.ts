/**
 * Phase 29 — Trade-time market snapshot (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: pure calc in `/src/lib`. rule #11: wording is
 * descriptive — the AVOID dialog states what the conditions ARE, not what
 * will happen.)
 *
 * One rule dominates this module: NEVER fake market data. When the
 * instrument has no live condition row, the row is stale, or the rating is
 * unrecognizable, the snapshot degrades to all-null + `marketDataMissing`
 * true — the trade still saves, the UI shows "No market data for this
 * instrument", and the edge analytics bucket those trades under "No data".
 */
import { FORCED_AVOID } from "./scoring-config";
import { sessionOf } from "./scoring";

/** GOOD/CAUTION/AVOID — anything else is untrusted (treated as no data). */
export type TradeRating = "GOOD" | "CAUTION" | "AVOID";

export type TradeMarketSnapshot = {
  marketRating: string | null;
  marketScore: number | null;
  volatilityPercentile: number | null;
  marketSession: string | null;
  marketDataMissing: boolean;
};

/**
 * Normalize a trade asset ("EUR/USD", "eurusd", "EUR/USD OTC") to the
 * instrument-symbol form ("EUR_USD"). OTC / free-text assets simply won't
 * match an Instrument row — which is exactly how they end up "no data".
 */
export function normalizeAssetToSymbol(asset: string): string {
  return asset.trim().toUpperCase().replace(/[\/\s]+/g, "_");
}

/** Normalize a raw condition rating; null when unknown (never guessed). */
export function normalizeRating(raw: string | null | undefined): TradeRating | null {
  return raw === "GOOD" || raw === "CAUTION" || raw === "AVOID" ? raw : null;
}

/** The canonical "no data" snapshot (all null, flagged). */
export function noDataSnapshot(): TradeMarketSnapshot {
  return {
    marketRating: null,
    marketScore: null,
    volatilityPercentile: null,
    marketSession: null,
    marketDataMissing: true,
  };
}

export type ConditionRowForSnapshot = {
  rating: string;
  score: number;
  /** `MarketCondition.meta` JSON — may be null on pre-Phase-28 rows. */
  meta: unknown;
  computedAt: Date;
};

/**
 * Build the snapshot fields for a trade from the pair's live MarketCondition.
 * Returns `noDataSnapshot()` when the row is older than the stale threshold
 * (`FORCED_AVOID.maxDataAgeSeconds`, the same 180s the score uses) or its
 * rating is unrecognizable — stale/untrusted conditions are never written
 * onto a trade as if they were real.
 */
export function snapshotFromCondition(
  row: ConditionRowForSnapshot,
  now: Date,
): TradeMarketSnapshot {
  const ageMs = now.getTime() - row.computedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs > FORCED_AVOID.maxDataAgeSeconds * 1000) {
    return noDataSnapshot();
  }
  const rating = normalizeRating(row.rating);
  if (!rating) return noDataSnapshot();
  if (!Number.isFinite(row.score)) return noDataSnapshot();

  const meta = (row.meta ?? null) as Record<string, unknown> | null;
  const volRaw = meta?.volatilityPercentile;
  const volatilityPercentile =
    typeof volRaw === "number" && Number.isFinite(volRaw) && volRaw >= 0 && volRaw <= 100
      ? volRaw
      : null;
  const metaSession = typeof meta?.session === "string" && meta.session.length > 0
    ? meta.session
    : null;

  return {
    marketRating: rating,
    marketScore: Math.round(row.score),
    volatilityPercentile,
    // The row is fresh (staleness checked above), so the session derived from
    // `now` is the session the condition was computed in.
    marketSession: metaSession ?? sessionOf(now),
    marketDataMissing: false,
  };
}

// ─── AVOID warning flow (Add Trade + pre-trade screen) ──────────────────────

export type AvoidDecisionInput = {
  /** Snapshot rating (null = no data → no warning, ever). */
  rating: string | null;
  /** User setting: warnings on/off (Settings → market warnings). */
  warningsEnabled: boolean;
  /** The trading account's type — the demo carve-out keys off this. */
  accountType: "DEMO" | "REAL";
  /** User setting: don't block DEMO accounts with the AVOID dialog. */
  ignoreAvoidOnDemo: boolean;
};

/**
 * Should the AVOID confirmation dialog appear before this trade saves?
 * OTC/unknown instruments (rating null) and CAUTION never confirm; the demo
 * carve-out applies only when the user enabled it. Advisory by design — the
 * server never blocks on this, it only logs the choice.
 */
export function avoidConfirmationRequired(input: AvoidDecisionInput): boolean {
  if (!input.warningsEnabled) return false;
  if (input.rating !== "AVOID") return false;
  if (input.accountType === "DEMO" && input.ignoreAvoidOnDemo) return false;
  return true;
}

export type AvoidWarningDetails = {
  /** Human sentence for the dialog body (descriptive, past/present tense). */
  headline: string;
  /** First reason(s) shown as detail lines. */
  reasons: string[];
};

/**
 * Build the AVOID dialog copy from the live condition. Example output:
 * "Conditions look unfavorable: high-impact news in 8 minutes." — states the
 * observed condition, no prediction, no signal language (rule #11).
 */
export function describeAvoidWarning(input: {
  rating: string | null;
  score: number | null;
  reasons: string[];
  nextNewsTitle: string | null;
  nextNewsMinutesTo: number | null;
}): AvoidWarningDetails {
  const reasons = input.reasons.filter((r) => r.trim().length > 0).slice(0, 3);
  let headline: string;
  if (
    input.nextNewsTitle &&
    input.nextNewsMinutesTo != null &&
    Number.isFinite(input.nextNewsMinutesTo)
  ) {
    const mins = Math.max(0, Math.round(input.nextNewsMinutesTo));
    headline = `Conditions look unfavorable: high-impact news in ${mins} minute${mins === 1 ? "" : "s"}.`;
  } else if (reasons.length > 0) {
    headline = `Conditions look unfavorable: ${reasons[0]}`;
  } else if (input.score != null) {
    headline = `Conditions look unfavorable: the market rating is AVOID (score ${Math.round(input.score)}).`;
  } else {
    headline = "Conditions look unfavorable: this pair is rated AVOID right now.";
  }
  return { headline, reasons };
}
