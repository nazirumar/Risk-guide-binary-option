/**
 * Phase 29 — tests for `src/lib/market/trade-snapshot.ts` (pure snapshot +
 * AVOID warning logic).
 *
 * Covers:
 *   - normalizeAssetToSymbol: slash → underscore, case/trim normalization,
 *     OTC suffix survives (so it never matches a watchlisted instrument).
 *   - normalizeRating: only GOOD/CAUTION/AVOID pass; anything else → null.
 *   - snapshotFromCondition: fresh row maps fields; STALE row (>180s),
 *     unknown rating and NaN score all degrade to no-data (never faked);
 *     meta-less rows fall back to sessionOf(now); out-of-range volatility
 *     percentile → null without flagging the whole snapshot missing.
 *   - avoidConfirmationRequired: the full warnings/settings/account matrix —
 *     OTC (null rating) and CAUTION never confirm; DEMO carve-out only when
 *     the user enabled it; warnings-off disables everything.
 *   - describeAvoidWarning: spec example copy ("high-impact news in 8
 *     minutes"), singular "1 minute", reason/score fallbacks, ≤3 reasons.
 *
 * Wording rule (PROJECT_RULES.md #11): dialog copy states observed conditions
 * only — assertions pin that wording so promise language can't creep in.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeAssetToSymbol,
  normalizeRating,
  noDataSnapshot,
  snapshotFromCondition,
  avoidConfirmationRequired,
  describeAvoidWarning,
} from "@/lib/market/trade-snapshot";
import { sessionOf } from "@/lib/market/scoring";

const NOW = new Date("2025-06-15T12:00:00Z");

function freshRow(over: Partial<{ rating: string; score: number; meta: unknown; computedAt: Date }> = {}) {
  return {
    rating: "GOOD",
    score: 82,
    meta: { volatilityPercentile: 45, session: "LONDON" },
    computedAt: NOW,
    ...over,
  };
}

// ─── normalizeAssetToSymbol ──────────────────────────────────────────────────

describe("normalizeAssetToSymbol", () => {
  it("converts slash pairs to instrument-symbol form", () => {
    expect(normalizeAssetToSymbol("EUR/USD")).toBe("EUR_USD");
    expect(normalizeAssetToSymbol("GBP/JPY")).toBe("GBP_JPY");
  });

  it("trims and uppercases free-text input", () => {
    expect(normalizeAssetToSymbol("  eur/usd ")).toBe("EUR_USD");
    expect(normalizeAssetToSymbol("btc")).toBe("BTC");
  });

  it("keeps OTC suffixes distinct (they must NOT match EUR_USD)", () => {
    expect(normalizeAssetToSymbol("EUR/USD OTC")).toBe("EUR_USD_OTC");
    expect(normalizeAssetToSymbol("EUR/USD OTC")).not.toBe("EUR_USD");
  });
});

// ─── normalizeRating ─────────────────────────────────────────────────────────

describe("normalizeRating", () => {
  it("passes the three known ratings through", () => {
    expect(normalizeRating("GOOD")).toBe("GOOD");
    expect(normalizeRating("CAUTION")).toBe("CAUTION");
    expect(normalizeRating("AVOID")).toBe("AVOID");
  });

  it("anything unknown → null (never guessed)", () => {
    expect(normalizeRating("good")).toBeNull();
    expect(normalizeRating("BROKEN")).toBeNull();
    expect(normalizeRating("")).toBeNull();
    expect(normalizeRating(null)).toBeNull();
    expect(normalizeRating(undefined)).toBeNull();
  });
});

// ─── noDataSnapshot ──────────────────────────────────────────────────────────

describe("noDataSnapshot", () => {
  it("is all-null with the missing flag set", () => {
    expect(noDataSnapshot()).toEqual({
      marketRating: null,
      marketScore: null,
      volatilityPercentile: null,
      marketSession: null,
      marketDataMissing: true,
    });
  });
});

// ─── snapshotFromCondition ───────────────────────────────────────────────────

describe("snapshotFromCondition", () => {
  it("fresh trusted row → full snapshot, not missing", () => {
    const s = snapshotFromCondition(freshRow({ score: 82.4 }), NOW);
    expect(s).toEqual({
      marketRating: "GOOD",
      marketScore: 82, // rounded
      volatilityPercentile: 45,
      marketSession: "LONDON",
      marketDataMissing: false,
    });
  });

  it("stale row (older than 180s) → no data, never a stale rating on a trade", () => {
    const s = snapshotFromCondition(
      freshRow({ computedAt: new Date(NOW.getTime() - 181_000) }),
      NOW,
    );
    expect(s.marketDataMissing).toBe(true);
    expect(s.marketRating).toBeNull();
  });

  it("row exactly at the 180s threshold is still trusted", () => {
    const s = snapshotFromCondition(
      freshRow({ computedAt: new Date(NOW.getTime() - 180_000) }),
      NOW,
    );
    expect(s.marketDataMissing).toBe(false);
  });

  it("unknown rating → no data (untrusted strings are not written)", () => {
    const s = snapshotFromCondition(freshRow({ rating: "MAYBE" }), NOW);
    expect(s.marketDataMissing).toBe(true);
    expect(s.marketRating).toBeNull();
  });

  it("NaN score → no data", () => {
    const s = snapshotFromCondition(freshRow({ score: Number.NaN }), NOW);
    expect(s.marketDataMissing).toBe(true);
  });

  it("meta-less row (pre-Phase-28) → session falls back to sessionOf(now)", () => {
    const s = snapshotFromCondition(freshRow({ meta: null }), NOW);
    expect(s.marketDataMissing).toBe(false);
    expect(s.marketSession).toBe(sessionOf(NOW));
    expect(s.volatilityPercentile).toBeNull();
  });

  it("out-of-range volatility percentile → null field, but snapshot still present", () => {
    const s = snapshotFromCondition(
      freshRow({ meta: { volatilityPercentile: 150, session: "LONDON" } }),
      NOW,
    );
    expect(s.volatilityPercentile).toBeNull();
    expect(s.marketDataMissing).toBe(false);
    expect(s.marketRating).toBe("GOOD");
  });

  it("empty meta session string falls back to sessionOf(now)", () => {
    const s = snapshotFromCondition(
      freshRow({ meta: { volatilityPercentile: 10, session: "" } }),
      NOW,
    );
    expect(s.marketSession).toBe(sessionOf(NOW));
  });
});

// ─── avoidConfirmationRequired ───────────────────────────────────────────────

describe("avoidConfirmationRequired — warning decision matrix", () => {
  const base = {
    rating: "AVOID" as string | null,
    warningsEnabled: true,
    accountType: "REAL" as "DEMO" | "REAL",
    ignoreAvoidOnDemo: false,
  };

  it("AVOID + warnings on + REAL account → dialog required", () => {
    expect(avoidConfirmationRequired(base)).toBe(true);
  });

  it("AVOID + DEMO account without the carve-out → dialog required", () => {
    expect(avoidConfirmationRequired({ ...base, accountType: "DEMO" })).toBe(true);
  });

  it("AVOID + DEMO + user enabled the carve-out → skipped", () => {
    expect(
      avoidConfirmationRequired({ ...base, accountType: "DEMO", ignoreAvoidOnDemo: true }),
    ).toBe(false);
  });

  it("carve-out on a REAL account does NOT skip the dialog", () => {
    expect(avoidConfirmationRequired({ ...base, ignoreAvoidOnDemo: true })).toBe(true);
  });

  it("warnings disabled in settings → never confirms", () => {
    expect(avoidConfirmationRequired({ ...base, warningsEnabled: false })).toBe(false);
  });

  it("CAUTION / GOOD never confirm", () => {
    expect(avoidConfirmationRequired({ ...base, rating: "CAUTION" })).toBe(false);
    expect(avoidConfirmationRequired({ ...base, rating: "GOOD" })).toBe(false);
  });

  it("no market data (OTC/unknown → rating null) never confirms", () => {
    expect(avoidConfirmationRequired({ ...base, rating: null })).toBe(false);
  });
});

// ─── describeAvoidWarning ────────────────────────────────────────────────────

describe("describeAvoidWarning — dialog copy", () => {
  it("spec example: high-impact news in N minutes", () => {
    const d = describeAvoidWarning({
      rating: "AVOID",
      score: 41,
      reasons: ["Price action is choppy."],
      nextNewsTitle: "US CPI",
      nextNewsMinutesTo: 8,
    });
    expect(d.headline).toBe("Conditions look unfavorable: high-impact news in 8 minutes.");
  });

  it("singular minute", () => {
    const d = describeAvoidWarning({
      rating: "AVOID",
      score: 41,
      reasons: [],
      nextNewsTitle: "US CPI",
      nextNewsMinutesTo: 1,
    });
    expect(d.headline).toBe("Conditions look unfavorable: high-impact news in 1 minute.");
  });

  it("falls back to the first condition reason when no news timing", () => {
    const d = describeAvoidWarning({
      rating: "AVOID",
      score: 35,
      reasons: ["Volatility is unusually high for this hour, so price action is erratic.", "Second reason."],
      nextNewsTitle: null,
      nextNewsMinutesTo: null,
    });
    expect(d.headline).toBe(
      "Conditions look unfavorable: Volatility is unusually high for this hour, so price action is erratic.",
    );
  });

  it("falls back to score, then generic copy", () => {
    expect(
      describeAvoidWarning({
        rating: "AVOID",
        score: 41.6,
        reasons: [],
        nextNewsTitle: null,
        nextNewsMinutesTo: null,
      }).headline,
    ).toBe("Conditions look unfavorable: the market rating is AVOID (score 42).");
    expect(
      describeAvoidWarning({
        rating: "AVOID",
        score: null,
        reasons: [],
        nextNewsTitle: null,
        nextNewsMinutesTo: null,
      }).headline,
    ).toBe("Conditions look unfavorable: this pair is rated AVOID right now.");
  });

  it("caps detail reasons at 3 and drops blanks", () => {
    const d = describeAvoidWarning({
      rating: "AVOID",
      score: 30,
      reasons: ["r1", "  ", "r2", "r3", "r4"],
      nextNewsTitle: null,
      nextNewsMinutesTo: null,
    });
    expect(d.reasons).toEqual(["r1", "r2", "r3"]);
  });

  it("copy states observed conditions only (no promises / no signals)", () => {
    const d = describeAvoidWarning({
      rating: "AVOID",
      score: 30,
      reasons: ["Spread is unusually wide."],
      nextNewsTitle: "NFP",
      nextNewsMinutesTo: 12,
    });
    const copy = `${d.headline} ${d.reasons.join(" ")}`;
    expect(copy).not.toMatch(
      /guarantee|will (lose|win|profit)|you (will|should) lose|guaranteed|sure to|signal/i,
    );
    expect(d.headline).toContain("Conditions look unfavorable");
  });
});
