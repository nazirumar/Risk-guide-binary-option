/**
 * Phase 23 — pure-calc tests for `src/lib/telegram/provider.ts` and
 * `src/lib/ai/review.ts`.
 *
 * Covers:
 *   - parseTelegramCommand: all 4 commands + /start with/without code +
 *     @BotName suffix + unknown commands.
 *   - generateLinkCode: format (RG-XXXX-XXXX), charset (no 0/O/1/I/L),
 *     uniqueness over a sample.
 *   - timingSafeCompare: match, mismatch, null/empty handling.
 *   - buildWeeklyStatsPrompt: NO personal data in the payload (the spec's
 *     acceptance test) — inspects the exact string.
 *   - parseWeeklyReviewResponse: valid JSON, markdown fences, wrong shape,
 *     non-JSON.
 *   - buildFallbackReview: rule-based suggestions for each trigger.
 *   - generateWeeklyReviewWithFallback: AI success, AI 429 retry then
 *     success, AI total failure → fallback, unparseable AI → fallback.
 *   - REVIEW_DISCLAIMER presence in every output.
 */
import { describe, it, expect } from "vitest";
import {
  parseTelegramCommand,
  generateLinkCode,
  timingSafeCompare,
  ConsoleTelegramProvider,
} from "@/lib/telegram/provider";
import {
  buildWeeklyStatsPrompt,
  parseWeeklyReviewResponse,
  buildFallbackReview,
  generateWeeklyReviewWithFallback,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_DISCLAIMER,
  RateLimitError,
  type AnthropicClient,
  type WeeklyStatsInput,
} from "@/lib/ai/review";

// ─── parseTelegramCommand ───────────────────────────────────────────────────

describe("parseTelegramCommand", () => {
  it("parses /start with a code", () => {
    expect(parseTelegramCommand("/start RG-4F2A-9C1B")).toEqual({
      kind: "start",
      code: "RG-4F2A-9C1B",
    });
  });

  it("parses /start without a code", () => {
    expect(parseTelegramCommand("/start")).toEqual({ kind: "start", code: undefined });
  });

  it("normalizes the code to uppercase", () => {
    expect(parseTelegramCommand("/start rg-abcd-1234")).toEqual({
      kind: "start",
      code: "RG-ABCD-1234",
    });
  });

  it("strips the @BotName suffix from commands", () => {
    expect(parseTelegramCommand("/status@RiskGuardBot")).toEqual({ kind: "status" });
    expect(parseTelegramCommand("/stop@RiskGuardBot")).toEqual({ kind: "stop" });
  });

  it("parses /status, /stop, /help", () => {
    expect(parseTelegramCommand("/status")).toEqual({ kind: "status" });
    expect(parseTelegramCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseTelegramCommand("/help")).toEqual({ kind: "help" });
  });

  it("returns unknown for non-commands and unknown commands", () => {
    expect(parseTelegramCommand("hello")).toEqual({ kind: "unknown", raw: "hello" });
    expect(parseTelegramCommand("/foo")).toEqual({ kind: "unknown", raw: "/foo" });
    expect(parseTelegramCommand(undefined)).toEqual({ kind: "unknown", raw: "" });
  });
});

// ─── generateLinkCode ───────────────────────────────────────────────────────

describe("generateLinkCode", () => {
  it("matches the RG-XXXX-XXXX format", () => {
    const code = generateLinkCode();
    expect(code).toMatch(/^RG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("never contains ambiguous characters (0/O/1/I/L)", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateLinkCode();
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it("generates unique codes over a sample", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generateLinkCode());
    // 100 draws from a large charset — collisions are vanishingly unlikely.
    expect(codes.size).toBeGreaterThan(90);
  });
});

// ─── timingSafeCompare ──────────────────────────────────────────────────────

describe("timingSafeCompare", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeCompare("secret", "secret")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(timingSafeCompare("secret", "wrong")).toBe(false);
  });

  it("returns false for null/undefined/empty inputs", () => {
    expect(timingSafeCompare(null, "secret")).toBe(false);
    expect(timingSafeCompare("secret", null)).toBe(false);
    expect(timingSafeCompare(undefined, undefined)).toBe(false);
    expect(timingSafeCompare("", "secret")).toBe(false);
    expect(timingSafeCompare("secret", "")).toBe(false);
    expect(timingSafeCompare(undefined as unknown as string | null, "secret")).toBe(false);
  });
});

// ─── ConsoleTelegramProvider webhook verification ────────────────────────────

describe("ConsoleTelegramProvider.verifyWebhookSignature", () => {
  it("verifies the correct secret", () => {
    const p = new ConsoleTelegramProvider("my-webhook-secret");
    expect(p.verifyWebhookSignature("my-webhook-secret")).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const p = new ConsoleTelegramProvider("my-webhook-secret");
    expect(p.verifyWebhookSignature("wrong-secret")).toBe(false);
  });

  it("rejects a missing header", () => {
    const p = new ConsoleTelegramProvider("my-webhook-secret");
    expect(p.verifyWebhookSignature(null)).toBe(false);
    expect(p.verifyWebhookSignature(undefined as unknown as string | null)).toBe(false);
  });
});

// ─── buildWeeklyStatsPrompt — NO personal data (acceptance test) ─────────────

describe("buildWeeklyStatsPrompt — no personal data in the payload", () => {
  const stats: WeeklyStatsInput = {
    weekStart: "2025-06-09",
    weekEnd: "2025-06-15",
    netPL: 125.5,
    totalTrades: 42,
    wins: 24,
    losses: 16,
    ties: 2,
    winRate: 0.571,
    profitFactor: 1.45,
    tiltEvents: 2,
    avgDisciplineScore: 82,
    bestStrategy: { name: "Trend-following", expectancyPerTrade: 5.2, trades: 18 },
    worstStrategy: { name: "Counter-trend", expectancyPerTrade: -3.1, trades: 12 },
    bestHour: 14,
    worstHour: 22,
    topEmotions: [
      { emotion: "CALM", count: 20 },
      { emotion: "GREEDY", count: 8 },
    ],
    ruleBreaches: 1,
    withdrewCount: 1,
  };

  it("the prompt contains the aggregated stats", () => {
    const prompt = buildWeeklyStatsPrompt(stats);
    expect(prompt).toContain("2025-06-09");
    expect(prompt).toContain("125.50");
    expect(prompt).toContain("Trend-following");
    expect(prompt).toContain("Tilt events: 2");
  });

  it("the prompt contains NO email, name, or screenshot data", () => {
    const prompt = buildWeeklyStatsPrompt(stats);
    // Common PII patterns that must never appear.
    expect(prompt.toLowerCase()).not.toMatch(/@/); // no email addresses
    expect(prompt.toLowerCase()).not.toContain("email");
    expect(prompt.toLowerCase()).not.toContain("password");
    expect(prompt.toLowerCase()).not.toContain("screenshot");
    // "user's local time" is a timezone label (not personal data) — check
    // for identifying phrases instead.
    expect(prompt.toLowerCase()).not.toContain("trader id");
    expect(prompt.toLowerCase()).not.toContain("account id");
    expect(prompt.toLowerCase()).not.toContain("username");
  });

  it("the system prompt reinforces the privacy + no-financial-advice rules", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("aggregated, anonymous");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Never promise profits");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Never give financial advice");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Past results don't guarantee future outcomes");
  });

  it("REVIEW_DISCLAIMER states past performance + no advice", () => {
    expect(REVIEW_DISCLAIMER).toContain("past performance");
    expect(REVIEW_DISCLAIMER.toLowerCase()).toContain("not financial advice");
    expect(REVIEW_DISCLAIMER).toContain("don't guarantee future outcomes");
  });
});

// ─── parseWeeklyReviewResponse ──────────────────────────────────────────────

describe("parseWeeklyReviewResponse", () => {
  it("parses valid JSON", () => {
    const r = parseWeeklyReviewResponse(`{"summary":"Good week.","suggestions":["A","B","C"]}`);
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Good week.");
    expect(r!.suggestions).toEqual(["A", "B", "C"]);
    expect(r!.source).toBe("ai");
  });

  it("strips markdown fences", () => {
    const r = parseWeeklyReviewResponse('```json\n{"summary":"Ok.","suggestions":["X"]}\n```');
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Ok.");
  });

  it("returns null for wrong shape (no suggestions array)", () => {
    expect(parseWeeklyReviewResponse(`{"summary":"Only summary"}`)).toBeNull();
    expect(parseWeeklyReviewResponse(`{"suggestions":["a"]}`)).toBeNull();
    expect(parseWeeklyReviewResponse(`{"summary":123,"suggestions":[]}`)).toBeNull();
  });

  it("returns null for non-JSON", () => {
    expect(parseWeeklyReviewResponse("This is not JSON at all.")).toBeNull();
  });

  it("returns null for empty suggestions", () => {
    expect(parseWeeklyReviewResponse(`{"summary":"S","suggestions":[]}`)).toBeNull();
  });
});

// ─── buildFallbackReview ─────────────────────────────────────────────────────

describe("buildFallbackReview — rule-based suggestions", () => {
  const baseStats: WeeklyStatsInput = {
    weekStart: "2025-06-09",
    weekEnd: "2025-06-15",
    netPL: -50,
    totalTrades: 20,
    wins: 8,
    losses: 11,
    ties: 1,
    winRate: 0.4,
    profitFactor: 0.7,
    tiltEvents: 1,
    avgDisciplineScore: 70,
    bestStrategy: null,
    worstStrategy: { name: "Counter-trend", expectancyPerTrade: -4.5, trades: 8 },
    bestHour: 14,
    worstHour: 22,
    topEmotions: [{ emotion: "REVENGE", count: 5 }],
    ruleBreaches: 0,
    withdrewCount: 0,
  };

  it("summarizes a losing week (disclaimer is appended by the orchestrator)", () => {
    const r = buildFallbackReview(baseStats);
    expect(r.summary).toContain("losing");
    expect(r.summary).toContain("-50.00");
    // The orchestrator (generateWeeklyReviewWithFallback) appends the
    // disclaimer to the fallback path — verified in the orchestrator tests below.
    expect(r.source).toBe("fallback");
  });

  it("suggests pausing the worst strategy when it has negative expectancy", () => {
    const r = buildFallbackReview(baseStats);
    expect(r.suggestions.some((s) => s.includes("Counter-trend"))).toBe(true);
  });

  it("suggests a cooldown when tilt events occurred", () => {
    const r = buildFallbackReview(baseStats);
    expect(r.suggestions.some((s) => s.includes("cooldown"))).toBe(true);
  });

  it("suggests discipline improvement when avg score < 80", () => {
    const r = buildFallbackReview(baseStats);
    expect(r.suggestions.some((s) => s.includes("discipline score"))).toBe(true);
  });

  it("caps suggestions at 3", () => {
    const r = buildFallbackReview(baseStats);
    expect(r.suggestions.length).toBeLessThanOrEqual(3);
  });

  it("profitable week with no issues → encouraging summary + generic suggestion", () => {
    const good: WeeklyStatsInput = {
      ...baseStats,
      netPL: 200,
      totalTrades: 30,
      wins: 20,
      losses: 10,
      ties: 0,
      winRate: 0.667,
      tiltEvents: 0,
      avgDisciplineScore: 95,
      worstStrategy: null,
      worstHour: null,
    };
    const r = buildFallbackReview(good);
    expect(r.summary).toContain("profitable");
    expect(r.summary).toContain("No tilt events");
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});

// ─── generateWeeklyReviewWithFallback ───────────────────────────────────────

describe("generateWeeklyReviewWithFallback — retries + fallback", () => {
  const stats: WeeklyStatsInput = {
    weekStart: "2025-06-09",
    weekEnd: "2025-06-15",
    netPL: 100,
    totalTrades: 20,
    wins: 12,
    losses: 7,
    ties: 1,
    winRate: 0.6,
    profitFactor: 1.4,
    tiltEvents: 0,
    avgDisciplineScore: 90,
    bestStrategy: null,
    worstStrategy: null,
    bestHour: 10,
    worstHour: null,
    topEmotions: [],
    ruleBreaches: 0,
    withdrewCount: 0,
  };

  const noSleep = () => Promise.resolve(); // instant for tests

  it("AI success → parsed review with disclaimer appended", async () => {
    const client: AnthropicClient = {
      complete: () => Promise.resolve(`{"summary":"Solid week.","suggestions":["S1","S2","S3"]}`),
    };
    const r = await generateWeeklyReviewWithFallback(stats, client, noSleep);
    expect(r.source).toBe("ai");
    expect(r.summary).toContain("Solid week.");
    expect(r.summary).toContain(REVIEW_DISCLAIMER);
    expect(r.suggestions).toEqual(["S1", "S2", "S3"]);
  });

  it("AI rate-limited twice then succeeds → returns the AI review (retries work)", async () => {
    let attempts = 0;
    const client: AnthropicClient = {
      complete: () => {
        attempts++;
        if (attempts <= 2) throw new RateLimitError("429");
        return Promise.resolve(`{"summary":"Third try.","suggestions":["A","B","C"]}`);
      },
    };
    const r = await generateWeeklyReviewWithFallback(stats, client, noSleep);
    expect(attempts).toBe(3);
    expect(r.source).toBe("ai");
    expect(r.summary).toContain("Third try.");
  });

  it("AI rate-limited on all attempts → falls back to the rule-based review", async () => {
    const client: AnthropicClient = {
      complete: () => Promise.reject(new RateLimitError("429")),
    };
    const r = await generateWeeklyReviewWithFallback(stats, client, noSleep);
    expect(r.source).toBe("fallback");
    expect(r.summary).toContain(REVIEW_DISCLAIMER);
  });

  it("AI returns unparseable output → falls back", async () => {
    const client: AnthropicClient = {
      complete: () => Promise.resolve("I am sorry, I cannot comply."),
    };
    const r = await generateWeeklyReviewWithFallback(stats, client, noSleep);
    expect(r.source).toBe("fallback");
  });

  it("null client (AI disabled) → falls back immediately with the disclaimer", async () => {
    const r = await generateWeeklyReviewWithFallback(stats, null, noSleep);
    expect(r.source).toBe("fallback");
    expect(r.summary).toContain(REVIEW_DISCLAIMER);
    expect(r.summary).toContain("profitable"); // stats say +100 → "profitable"
  });

  it("AI network error (non-429) → falls back without retrying", async () => {
    let attempts = 0;
    const client: AnthropicClient = {
      complete: () => {
        attempts++;
        return Promise.reject(new Error("Network unreachable"));
      },
    };
    const r = await generateWeeklyReviewWithFallback(stats, client, noSleep);
    expect(attempts).toBe(1); // no retry on non-429 errors
    expect(r.source).toBe("fallback");
  });
});
