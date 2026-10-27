import { describe, it, expect } from "vitest";
import { detectTilt, SIGNAL_WEIGHTS } from "@/lib/behavior/tilt";
import type { TiltTradeLike, TiltConfig } from "@/lib/behavior/tilt";

const NOW = new Date("2026-10-26T14:00:00Z"); // Monday 14:00 UTC

const DEFAULT_CONFIG: TiltConfig = {
  tiltDetectionEnabled: true,
  tiltThreshold: 60,
  rapidRetradeMinutes: 2,
  stakeEscalationFactor: 1.5,
  maxTradesPerHour: 6,
  tradingHours: null, // no hours restriction by default
};

function trade(overrides: Partial<TiltTradeLike> = {}): TiltTradeLike {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    openedAt: new Date("2026-10-26T13:00:00Z"), // 1 hour ago
    stake: 100,
    result: "WIN",
    emotion: null,
    profitLoss: 85,
    ...overrides,
  };
}

describe("detectTilt — no tilt scenarios", () => {
  it("empty trades → CALM, score 0, no signals", () => {
    const r = detectTilt([], DEFAULT_CONFIG, NOW);
    expect(r.score).toBe(0);
    expect(r.level).toBe("CALM");
    expect(r.signals).toEqual([]);
  });

  it("single WIN trade → CALM", () => {
    const r = detectTilt([trade()], DEFAULT_CONFIG, NOW);
    expect(r.level).toBe("CALM");
    expect(r.score).toBe(0);
  });

  it("detection disabled → CALM regardless of trades", () => {
    const config = { ...DEFAULT_CONFIG, tiltDetectionEnabled: false };
    const r = detectTilt(
      [trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:59:00Z") })],
      config,
      NOW,
    );
    expect(r.level).toBe("CALM");
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });
});

describe("Signal 1: RAPID_RETRADE", () => {
  it("last trade LOSS 1 min ago (threshold 2 min) → triggers", () => {
    const r = detectTilt(
      [trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:59:00Z") })], // 1 min ago
      DEFAULT_CONFIG,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "RAPID_RETRADE");
    expect(s).toBeDefined();
    expect(s!.weight).toBe(SIGNAL_WEIGHTS.RAPID_RETRADE);
    expect(r.score).toBe(SIGNAL_WEIGHTS.RAPID_RETRADE);
  });

  it("last trade LOSS 5 min ago (threshold 2 min) → does NOT trigger", () => {
    const r = detectTilt(
      [trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:55:00Z") })], // 5 min ago
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "RAPID_RETRADE")).toBeUndefined();
  });

  it("last trade WIN (not LOSS) → does NOT trigger even if recent", () => {
    const r = detectTilt(
      [trade({ result: "WIN", openedAt: new Date("2026-10-26T13:59:00Z") })],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "RAPID_RETRADE")).toBeUndefined();
  });

  it("no trades → does NOT trigger", () => {
    const r = detectTilt([], DEFAULT_CONFIG, NOW);
    expect(r.signals.find((s) => s.signal === "RAPID_RETRADE")).toBeUndefined();
  });
});

describe("Signal 2: STAKE_SPIKE_AFTER_LOSS", () => {
  const config: TiltConfig = { ...DEFAULT_CONFIG, stakeEscalationFactor: 1.5 };

  it("stake 200 (2× median 100) after loss → triggers", () => {
    // Chronological: LOSS(stake=100) → WIN(stake=200) — the user lost, then increased stake.
    // Most-recent-first: WIN(stake=200), LOSS(stake=100), WIN(stake=100).
    const r = detectTilt(
      [
        trade({ result: "WIN", stake: 200, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "LOSS", stake: 100, openedAt: new Date("2026-10-26T12:00:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-20T12:00:00Z") }),
      ],
      config,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "STAKE_SPIKE_AFTER_LOSS");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("2.0×");
  });

  it("stake 120 (1.2× median 100) after loss → does NOT trigger", () => {
    const r = detectTilt(
      [
        trade({ result: "WIN", stake: 120, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "LOSS", stake: 100, openedAt: new Date("2026-10-26T12:00:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-20T12:00:00Z") }),
      ],
      config,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "STAKE_SPIKE_AFTER_LOSS")).toBeUndefined();
  });

  it("stake spike but no LOSS before it → does NOT trigger", () => {
    const r = detectTilt(
      [
        trade({ result: "WIN", stake: 200, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "WIN", stake: 100, openedAt: new Date("2026-10-26T12:00:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-20T12:00:00Z") }),
      ],
      config,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "STAKE_SPIKE_AFTER_LOSS")).toBeUndefined();
  });
});

describe("Signal 3: CONSECUTIVE_LOSSES", () => {
  it("2 consecutive losses → triggers", () => {
    const r = detectTilt(
      [
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:00:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "CONSECUTIVE_LOSSES");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("2 consecutive losses");
  });

  it("1 loss then WIN → does NOT trigger", () => {
    const r = detectTilt(
      [
        trade({ result: "WIN", openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:00:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "CONSECUTIVE_LOSSES")).toBeUndefined();
  });

  it("3 consecutive losses → triggers with count 3", () => {
    const r = detectTilt(
      [
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:00:00Z") }),
        trade({ result: "LOSS", openedAt: new Date("2026-10-26T12:30:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "CONSECUTIVE_LOSSES");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("3 consecutive losses");
  });
});

describe("Signal 4: RAPID_TRADING", () => {
  it("7 trades in last hour (threshold 6) → triggers", () => {
    const trades = Array.from({ length: 7 }, (_, i) =>
      trade({ openedAt: new Date(`2026-10-26T13:${String(50 - i).padStart(2, "0")}:00Z`) }),
    );
    const r = detectTilt(trades, DEFAULT_CONFIG, NOW);
    const s = r.signals.find((s) => s.signal === "RAPID_TRADING");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("7 trades");
  });

  it("5 trades in last hour (threshold 6) → does NOT trigger", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      trade({ openedAt: new Date(`2026-10-26T13:${String(50 - i).padStart(2, "0")}:00Z`) }),
    );
    const r = detectTilt(trades, DEFAULT_CONFIG, NOW);
    expect(r.signals.find((s) => s.signal === "RAPID_TRADING")).toBeUndefined();
  });
});

describe("Signal 5: OUTSIDE_TRADING_HOURS", () => {
  const configWithHours: TiltConfig = {
    ...DEFAULT_CONFIG,
    tradingHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
  };

  it("14:00 UTC (within 09:00-17:00 Mon-Fri) → does NOT trigger", () => {
    // 2026-10-26 is a Monday
    const r = detectTilt([trade()], configWithHours, NOW);
    expect(r.signals.find((s) => s.signal === "OUTSIDE_TRADING_HOURS")).toBeUndefined();
  });

  it("20:00 UTC (outside 09:00-17:00) → triggers", () => {
    const now = new Date("2026-10-26T20:00:00Z");
    const r = detectTilt([trade()], configWithHours, now);
    const s = r.signals.find((s) => s.signal === "OUTSIDE_TRADING_HOURS");
    expect(s).toBeDefined();
  });

  it("Saturday (outside Mon-Fri) → triggers", () => {
    // 2026-10-31 is a Saturday
    const now = new Date("2026-10-31T12:00:00Z");
    const r = detectTilt([trade({ openedAt: now })], configWithHours, now);
    expect(r.signals.find((s) => s.signal === "OUTSIDE_TRADING_HOURS")).toBeDefined();
  });

  it("no tradingHours config → does NOT trigger", () => {
    const r = detectTilt([trade()], DEFAULT_CONFIG, NOW);
    expect(r.signals.find((s) => s.signal === "OUTSIDE_TRADING_HOURS")).toBeUndefined();
  });
});

describe("Signal 6: NEGATIVE_EMOTION", () => {
  it("REVENGE on last trade → triggers", () => {
    const r = detectTilt([trade({ emotion: "REVENGE" })], DEFAULT_CONFIG, NOW);
    const s = r.signals.find((s) => s.signal === "NEGATIVE_EMOTION");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("REVENGE");
  });

  it("CALM on last trade → does NOT trigger", () => {
    const r = detectTilt([trade({ emotion: "CALM" })], DEFAULT_CONFIG, NOW);
    expect(r.signals.find((s) => s.signal === "NEGATIVE_EMOTION")).toBeUndefined();
  });

  it("GREEDY on 2nd of 3 trades → triggers", () => {
    const r = detectTilt(
      [trade({ emotion: "CALM" }), trade({ emotion: "GREEDY" }), trade({ emotion: "CALM" })],
      DEFAULT_CONFIG,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "NEGATIVE_EMOTION");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("GREEDY");
  });

  it("FEARFUL on 4th trade back → does NOT trigger (only checks last 3)", () => {
    const r = detectTilt(
      [
        trade({ emotion: "CALM" }),
        trade({ emotion: "CALM" }),
        trade({ emotion: "CALM" }),
        trade({ emotion: "FEARFUL" }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "NEGATIVE_EMOTION")).toBeUndefined();
  });
});

describe("Signal 7: STAKE_ESCALATION_PATTERN", () => {
  it("3 consecutive increasing stakes → triggers", () => {
    // Most recent first: 300, 200, 100 — each is higher than the next (chronological order: 100, 200, 300)
    const r = detectTilt(
      [
        trade({ stake: 300, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ stake: 200, openedAt: new Date("2026-10-26T13:00:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-26T12:30:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    const s = r.signals.find((s) => s.signal === "STAKE_ESCALATION_PATTERN");
    expect(s).toBeDefined();
    expect(s!.detail).toContain("3 consecutive trades");
  });

  it("2 increasing stakes then decrease → does NOT trigger", () => {
    const r = detectTilt(
      [
        trade({ stake: 200, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-26T13:00:00Z") }),
        trade({ stake: 150, openedAt: new Date("2026-10-26T12:30:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "STAKE_ESCALATION_PATTERN")).toBeUndefined();
  });

  it("flat stakes → does NOT trigger", () => {
    const r = detectTilt(
      [
        trade({ stake: 100, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-26T13:00:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-26T12:30:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.signals.find((s) => s.signal === "STAKE_ESCALATION_PATTERN")).toBeUndefined();
  });
});

describe("Score combinations", () => {
  it("all 7 signals → score 90, TILT", () => {
    // Trigger all signals except OUTSIDE_TRADING_HOURS (no tradingHours config).
    const trades = [
      // Most recent: LOSS with REVENGE, stake 400 (spike after LOSS below)
      trade({
        result: "LOSS",
        emotion: "REVENGE",
        stake: 400,
        openedAt: new Date("2026-10-26T13:59:00Z"),
      }),
      // LOSS for STAKE_SPIKE (prev is LOSS, current stake 400 > 100×1.5=150) + CONSECUTIVE_LOSSES
      trade({ result: "LOSS", stake: 100, openedAt: new Date("2026-10-26T13:55:00Z") }),
      // Fill up the last hour for RAPID_TRADING + STAKE_ESCALATION (60→70→80→90→100)
      trade({ stake: 100, openedAt: new Date("2026-10-26T13:50:00Z") }),
      trade({ stake: 90, openedAt: new Date("2026-10-26T13:40:00Z") }),
      trade({ stake: 80, openedAt: new Date("2026-10-26T13:30:00Z") }),
      trade({ stake: 70, openedAt: new Date("2026-10-26T13:20:00Z") }),
      trade({ stake: 60, openedAt: new Date("2026-10-26T13:10:00Z") }),
    ];
    // Signals that should fire:
    // RAPID_RETRADE (20): most recent is LOSS 1 min ago ✓
    // STAKE_SPIKE (20): prev=LOSS(100), current=LOSS(400) > 100×1.5=150 ✓
    // CONSECUTIVE_LOSSES (15): 2 consecutive losses ✓
    // RAPID_TRADING (15): 7 trades in last hour (> 6) ✓
    // NEGATIVE_EMOTION (10): REVENGE ✓
    // STAKE_ESCALATION (10): 60→70→80→90→100 (5 increasing) ✓
    // Total: 20+20+15+15+10+10 = 90 → TILT
    const config: TiltConfig = { ...DEFAULT_CONFIG, tiltThreshold: 60 };
    const r = detectTilt(trades, config, NOW);
    expect(r.level).toBe("TILT");
    expect(r.score).toBe(90);
    expect(r.signals.length).toBe(6);
  });

  it("2 signals → CAUTION (score between 40 and tiltThreshold)", () => {
    // RAPID_RETRADE (20) + NEGATIVE_EMOTION (10) = 30 → CALM
    // Need score >= 40 for CAUTION. CONSECUTIVE_LOSSES (15) + NEGATIVE_EMOTION (10) = 25 → CALM
    // RAPID_RETRADE (20) + CONSECUTIVE_LOSSES (15) = 35 → CALM
    // RAPID_RETRADE (20) + RAPID_TRADING (15) = 35 → CALM
    // Let me combine 3 signals: RAPID_RETRADE (20) + CONSECUTIVE_LOSSES (15) + NEGATIVE_EMOTION (10) = 45 → CAUTION
    const r = detectTilt(
      [
        trade({ result: "LOSS", emotion: "REVENGE", openedAt: new Date("2026-10-26T13:59:00Z") }),
        trade({ result: "LOSS", emotion: "FEARFUL", openedAt: new Date("2026-10-26T13:30:00Z") }),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.level).toBe("CAUTION");
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(60);
  });

  it("1 signal → CALM (score < 40)", () => {
    const r = detectTilt(
      [trade({ result: "LOSS", openedAt: new Date("2026-10-26T13:59:00Z") })],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(r.level).toBe("CALM");
    expect(r.score).toBe(SIGNAL_WEIGHTS.RAPID_RETRADE);
  });

  it("custom tiltThreshold 40 → score 55 = TILT", () => {
    const config: TiltConfig = { ...DEFAULT_CONFIG, tiltThreshold: 40 };
    // Trigger 3 signals: RAPID_RETRADE (20) + STAKE_SPIKE (20) + CONSECUTIVE_LOSSES (15) = 55
    // Most recent: LOSS(stake 200) — RAPID_RETRADE fires (LOSS 1 min ago)
    //              Also: STAKE_SPIKE fires (prev=LOSS(stake 100), current=200 > 100×1.5=150)
    //              Also: CONSECUTIVE_LOSSES fires (2 consecutive losses)
    const r = detectTilt(
      [
        trade({ result: "LOSS", stake: 200, openedAt: new Date("2026-10-26T13:59:00Z") }),
        trade({ result: "LOSS", stake: 100, openedAt: new Date("2026-10-26T13:30:00Z") }),
        trade({ stake: 100, openedAt: new Date("2026-10-20T12:00:00Z") }),
      ],
      config,
      NOW,
    );
    expect(r.level).toBe("TILT");
    expect(r.score).toBe(55);
  });
});

describe("First trade of the day", () => {
  it("single WIN trade with no history → CALM with no signals", () => {
    const r = detectTilt([trade()], DEFAULT_CONFIG, NOW);
    expect(r.level).toBe("CALM");
    expect(r.signals).toEqual([]);
  });

  it("first trade of day with REVENGE emotion → only emotion signal", () => {
    const r = detectTilt([trade({ emotion: "REVENGE" })], DEFAULT_CONFIG, NOW);
    expect(r.signals.length).toBe(1);
    expect(r.signals[0].signal).toBe("NEGATIVE_EMOTION");
    expect(r.level).toBe("CALM"); // only 10 points
  });
});
