/**
 * Phase 30.2 — pure unit tests for the AI journal coach.
 *
 * No DB, no network: the provider is injected directly into the orchestrator.
 * Covers the privacy fence, the banned-language post-check, the disclaimer,
 * and the deterministic fallback.
 */
import { describe, expect, it, vi } from "vitest";

import {
  COACH_DISCLAIMER,
  COACH_SYSTEM_PROMPT,
  buildCoachPrompt,
  buildFallbackCoachReply,
  containsBannedCoachLanguage,
  coachConversationTitle,
  generateCoachReplyWithFallback,
  sanitizeCoachInput,
  scrubPersonalData,
  shouldResetDailyCount,
  utcDayKey,
  type CoachAIClient,
  type CoachContext,
} from "@/lib/ai/coach";
import { RateLimitError } from "@/lib/ai/provider";

function context(notes?: string[]): CoachContext {
  const stats = {
    periodStart: "2026-10-22",
    periodEnd: "2026-11-20",
    totalTrades: 10,
    wins: 6,
    losses: 4,
    ties: 0,
    winRate: 0.6,
    netPL: 42.5,
    avgDisciplineScore: 72,
    tiltEvents: 2,
    ruleBreaches: 1,
    followedPlanRate: 0.8,
    topEmotions: [{ emotion: "CALM", count: 5 }],
  };
  return notes ? { stats, notes } : { stats };
}

function clientReturning(text: string | Error): CoachAIClient {
  return {
    name: "test",
    complete: vi.fn(async () => {
      if (text instanceof Error) throw text;
      return text;
    }),
  };
}

describe("scrubPersonalData", () => {
  it("removes email addresses and phone-like numbers", () => {
    const out = scrubPersonalData("Contact me at jane.doe@example.com or +1 555 123 4567 today.");
    expect(out).toContain("[email removed]");
    expect(out).toContain("[number removed]");
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain("555 123 4567");
  });
});

describe("sanitizeCoachInput / coachConversationTitle", () => {
  it("collapses whitespace, scrubs data and caps length", () => {
    const out = sanitizeCoachInput("  hello   world  ", 20);
    expect(out).toBe("hello world");
    expect(sanitizeCoachInput("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });

  it("uses a friendly title for empty input", () => {
    expect(coachConversationTitle("   ")).toBe("New reflection");
    expect(coachConversationTitle("Why do I tilt after losses?")).toBe(
      "Why do I tilt after losses?",
    );
  });
});

describe("containsBannedCoachLanguage", () => {
  it("flags promises, signals and advice wording", () => {
    for (const text of [
      "This is a guaranteed way to win.",
      "It's a sure thing.",
      "The best time to trade is 9am.",
      "Follow this trading signal.",
      "I give you financial advice.",
      "You should trade this pair.",
      "You will definitely profit.",
    ]) {
      expect(containsBannedCoachLanguage(text), text).toBe(true);
    }
  });

  it("allows discipline-focused wording", () => {
    expect(containsBannedCoachLanguage("Your pattern shows tilt after two losses.")).toBe(false);
    expect(containsBannedCoachLanguage("Consider a cooldown and keep logging.")).toBe(false);
  });
});

describe("buildCoachPrompt", () => {
  it("includes only aggregate stats, never identity fields", () => {
    const prompt = buildCoachPrompt(context(), "Why do I tilt?", []);
    expect(prompt).toContain("Trades: 10 (6W / 4L / 0T)");
    expect(prompt).toContain("Net P/L: 42.50");
    expect(prompt).toContain("Avg discipline score: 72/100");
    expect(prompt).toContain("Tilt events: 2");
    expect(prompt).toContain("Question: Why do I tilt?");
    expect(prompt.toLowerCase()).not.toContain("email");
    expect(prompt.toLowerCase()).not.toContain("screenshot");
  });

  it("adds notes only when the user opted in, and scrubs them", () => {
    const withNotes = context(["Felt rushed — mail me at bob@example.com"]);
    const prompt = buildCoachPrompt(withNotes, "Any patterns?", []);
    expect(prompt).toContain("own journal notes");
    expect(prompt).toContain("[email removed]");
    expect(prompt).not.toContain("bob@example.com");

    const withoutNotes = buildCoachPrompt(context(), "Any patterns?", []);
    expect(withoutNotes).not.toContain("own journal notes");
  });

  it("scrubs identity data typed in the question and history", () => {
    const prompt = buildCoachPrompt(context(), "Reach me at me@example.com", [
      { role: "user", content: "call me at 555 123 4567" },
    ]);
    expect(prompt).not.toContain("me@example.com");
    expect(prompt).not.toContain("555 123 4567");
  });

  it("system prompt forbids advice, promises and signal wording", () => {
    expect(COACH_SYSTEM_PROMPT).toContain("NEVER give financial advice");
    expect(COACH_SYSTEM_PROMPT).toContain("NEVER promise profits");
    expect(COACH_SYSTEM_PROMPT).toContain("guaranteed");
    expect(COACH_SYSTEM_PROMPT).toContain("best time to trade");
  });
});

describe("buildFallbackCoachReply", () => {
  it("is specific to the user's numbers, discipline-only and disclaimed", () => {
    const reply = buildFallbackCoachReply(context(), "How am I doing?");
    expect(reply).toContain("10 closed trades");
    expect(reply).toContain("60.0%");
    expect(reply).toContain("2 tilt events");
    expect(reply).toContain(COACH_DISCLAIMER);
    expect(containsBannedCoachLanguage(reply)).toBe(false);
  });

  it("handles an empty journal without inventing results", () => {
    const empty = context();
    empty.stats.totalTrades = 0;
    empty.stats.winRate = 0;
    empty.stats.followedPlanRate = null;
    const reply = buildFallbackCoachReply(empty, "");
    expect(reply).toContain("no closed trades");
    expect(reply).toContain(COACH_DISCLAIMER);
  });
});

describe("generateCoachReplyWithFallback", () => {
  it("uses the fallback when no client is configured", async () => {
    const res = await generateCoachReplyWithFallback(context(), "Hi", null);
    expect(res.source).toBe("fallback");
    expect(res.content).toContain(COACH_DISCLAIMER);
    expect(res.sharedContext).toEqual(context());
  });

  it("uses a valid AI reply and appends the disclaimer", async () => {
    const res = await generateCoachReplyWithFallback(
      context(),
      "How am I doing?",
      clientReturning("Your log shows a consistent routine. Keep the checklist close."),
    );
    expect(res.source).toBe("ai");
    expect(res.content).toContain("consistent routine");
    expect(res.content).toContain(COACH_DISCLAIMER);
    expect(res.content.endsWith(COACH_DISCLAIMER)).toBe(true);
  });

  it("rejects banned wording and falls back instead of storing it", async () => {
    const res = await generateCoachReplyWithFallback(
      context(),
      "Best pair?",
      clientReturning("This is a guaranteed signal — the best time to trade is now."),
    );
    expect(res.source).toBe("fallback");
    expect(res.content).not.toContain("guaranteed");
  });

  it("retries once on rate limit then succeeds", async () => {
    const client: CoachAIClient = {
      name: "test",
      complete: vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("429"))
        .mockResolvedValueOnce("Your notes show a steadier routine this month."),
    };
    const sleep = vi.fn(async () => {});
    const res = await generateCoachReplyWithFallback(context(), "Any change?", client, [], sleep);
    expect(res.source).toBe("ai");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("falls back on a non-rate-limit error", async () => {
    const res = await generateCoachReplyWithFallback(
      context(),
      "Hi",
      clientReturning(new Error("network down")),
    );
    expect(res.source).toBe("fallback");
  });
});

describe("daily quota helpers", () => {
  it("formats UTC day keys", () => {
    expect(utcDayKey(new Date("2026-11-20T23:59:00Z"))).toBe("2026-11-20");
  });

  it("resets when the last message was on a previous UTC day", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    expect(shouldResetDailyCount(null, now)).toBe(true);
    expect(shouldResetDailyCount(new Date("2026-11-19T23:00:00Z"), now)).toBe(true);
    expect(shouldResetDailyCount(new Date("2026-11-20T01:00:00Z"), now)).toBe(false);
  });
});
