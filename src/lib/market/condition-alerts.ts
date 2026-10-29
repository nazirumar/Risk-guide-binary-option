/**
 * Phase 28 — "favorite pair flipped rating" alert logic (pure, unit-tested).
 *
 * (PROJECT_RULES.md rule #2: pure calc in `/src/lib`. The worker calls these to
 * decide whether to dispatch an alert; the DB writes stay in the worker.)
 *
 * Spec: "notify when a favorite pair changes to GOOD or AVOID. Limit to one
 * alert per pair per 30 minutes. Off by default." The off-by-default gate is
 * the notification pref `MARKET_CONDITION_CHANGED` (registered with
 * inApp:false in DEFAULT_PREFS) — that IS "the existing notification system".
 */
import type { ConditionRating } from "@/lib/market/scoring";

/** Cooldown between alerts for the same (user, pair). */
export const MARKET_ALERT_COOLDOWN_MINUTES = 30;

/**
 * True only when a rating transition ENDS on an actionable rating (GOOD or
 * AVOID). CAUTION is not actionable, and "no change" is not a transition.
 *
 * AVOID counts too: a favorite flipping to AVOID is exactly the warning the
 * trader wants (spec: "changes to GOOD or AVOID").
 */
export function ratingChangedToActionable(
  previous: string | null | undefined,
  next: string,
): boolean {
  if (!previous) return false; // no prior row → not a change
  if (previous === next) return false;
  return next === "GOOD" || next === "AVOID";
}

/** True when the 30-minute cooldown has NOT yet elapsed (alert suppressed). */
export function alertCooldownActive(
  lastAlertAt: Date | null | undefined,
  now: Date,
  cooldownMinutes: number = MARKET_ALERT_COOLDOWN_MINUTES,
): boolean {
  if (!lastAlertAt) return false; // never alerted → cooldown inactive
  const elapsedMs = now.getTime() - lastAlertAt.getTime();
  return elapsedMs < cooldownMinutes * 60_000;
}

/** Plain-language alert copy. Descriptive only — never advisory (rule #11). */
export function buildMarketAlert(
  rating: ConditionRating,
  symbol: string,
): {
  title: string;
  body: string;
} {
  const pair = symbol.replace("_", "/");
  if (rating === "GOOD") {
    return {
      title: `${pair} conditions changed to GOOD`,
      body: `${pair} is now rated GOOD (${new Date().toISOString().slice(0, 10)}). Market conditions information only — not a trading signal.`,
    };
  }
  return {
    title: `${pair} conditions changed to AVOID`,
    body: `${pair} is now rated AVOID. Conditions are unfavorable (data, spread, session or news). Market conditions information only — not a trading signal.`,
  };
}
