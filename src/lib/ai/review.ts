/**
 * Pure AI weekly-review helpers for Phase 23 — Telegram & AI Review.
 *
 * (PROJECT_RULES.md rule #2: pure helpers. rule #11: the review text must
 * not promise profits or give financial advice — the prompt instructs the
 * model accordingly + a disclaimer is appended to every review.)
 *
 * PRIVACY (spec requirement): `buildWeeklyStatsSummary` accepts ONLY the
 * aggregated stats — the caller (server action) is responsible for passing
 * aggregates, never raw trades. The prompt sent to Anthropic contains no
 * email, name, screenshots, or any user-identifying data. A unit test
 * inspects the payload to enforce this.
 *
 * Fallback: when the Anthropic API fails (network / 429 / 500 after
 * retries), `generateWeeklyReviewWithFallback` falls back to the Phase 9
 * rule-based insights engine.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type WeeklyStatsInput = {
  /** ISO week start (e.g. "2025-06-09"). */
  weekStart: string;
  /** ISO week end. */
  weekEnd: string;
  netPL: number;
  totalTrades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // 0–1
  profitFactor: number;
  tiltEvents: number;
  avgDisciplineScore: number | null; // 0–100 (null when no scores logged)
  bestStrategy: { name: string; expectancyPerTrade: number; trades: number } | null;
  worstStrategy: { name: string; expectancyPerTrade: number; trades: number } | null;
  bestHour: number | null; // 0–23 in user TZ
  worstHour: number | null;
  topEmotions: { emotion: string; count: number }[];
  ruleBreaches: number; // lockout + warning overrides
  withdrewCount: number; // withdrawals taken that week
};

export type WeeklyReviewOutput = {
  summary: string;
  suggestions: string[];
  source: "ai" | "fallback";
};

// ─── Week helpers (pure) ─────────────────────────────────────────────────────

/**
 * Compute the ISO week [start, end) containing `d`. Weeks start Monday
 * 00:00 UTC.
 */
export function isoWeekRange(d: Date): { start: Date; end: Date } {
  const day = d.getUTCDay(); // 0=Sun
  const offsetFromMonday = (day + 6) % 7; // Mon=0 ... Sun=6
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offsetFromMonday),
  );
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

// ─── Anthropic client interface ──────────────────────────────────────────────

export interface AnthropicClient {
  /**
   * Send the prompt to Claude. Returns the response text. Throws on
   * failure (caller handles retries + fallback).
   */
  complete(prompt: string, systemPrompt: string): Promise<string>;
}

/**
 * Real Anthropic client using the Messages API. Requires ANTHROPIC_API_KEY.
 */
export class RealAnthropicClient implements AnthropicClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-5-20250929") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, systemPrompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.status === 429) {
      throw new RateLimitError(`Anthropic API rate limited (429).`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Anthropic API returned no text content.");
    return text;
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ─── System prompt + user prompt builder (pure) ──────────────────────────────

/**
 * The system prompt instructs Claude to:
 *   - Write a short plain-language review of the trader's week.
 *   - Give exactly 3 specific, actionable suggestions.
 *   - NEVER promise profits or give financial advice.
 *   - Output in the strict JSON shape { summary, suggestions }.
 */
export const REVIEW_SYSTEM_PROMPT = `You are a trading-discipline coach for a binary-options journaling app. You receive ONLY aggregated, anonymous weekly statistics — never personal data, emails, names, or screenshots.

Write:
1. "summary": a short (3-5 sentence) plain-language review of the trader's week. Reference the actual numbers. Be encouraging but honest.
2. "suggestions": an array of EXACTLY 3 strings. Each is one specific, actionable suggestion tied to the week's data (e.g. "Your tilt events clustered on Tuesday after 3 losses — consider a 15-minute cooldown rule after 2 consecutive losses").

STRICT RULES:
- Never promise profits or predict future performance. Past results don't guarantee future outcomes.
- Never give financial advice (what to trade, when to enter, position sizing recommendations framed as advice). Focus on PROCESS and DISCIPLINE, not market direction.
- Never mention that you are an AI. Never mention the app's name.
- Output ONLY valid JSON: {"summary": "...", "suggestions": ["...", "...", "..."]}. No markdown fences, no preamble.`;

/**
 * Build the user prompt from the aggregated weekly stats. The prompt
 * contains ONLY the stats passed in — no email, name, or screenshots.
 * (A unit test inspects the exact payload to enforce this.)
 */
export function buildWeeklyStatsPrompt(stats: WeeklyStatsInput): string {
  const lines: string[] = [
    `Week ${stats.weekStart} to ${stats.weekEnd}:`,
    ``,
    `Net P/L: ${stats.netPL.toFixed(2)}`,
    `Trades: ${stats.totalTrades} (${stats.wins}W / ${stats.losses}L / ${stats.ties}T)`,
    `Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Profit factor: ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "N/A (no losses)"}`,
    `Tilt events: ${stats.tiltEvents}`,
    `Avg discipline score: ${stats.avgDisciplineScore == null ? "N/A" : stats.avgDisciplineScore.toFixed(0)}`,
    `Rule breaches (lockout + warning overrides): ${stats.ruleBreaches}`,
    `Withdrawals taken: ${stats.withdrewCount}`,
  ];
  if (stats.bestStrategy) {
    lines.push(
      `Best strategy: "${stats.bestStrategy.name}" (${stats.bestStrategy.trades} trades, expectancy ${stats.bestStrategy.expectancyPerTrade.toFixed(2)}/trade)`,
    );
  }
  if (stats.worstStrategy) {
    lines.push(
      `Worst strategy: "${stats.worstStrategy.name}" (${stats.worstStrategy.trades} trades, expectancy ${stats.worstStrategy.expectancyPerTrade.toFixed(2)}/trade)`,
    );
  }
  if (stats.bestHour != null) {
    lines.push(`Best hour (user's local time): ${String(stats.bestHour).padStart(2, "0")}:00`);
  }
  if (stats.worstHour != null) {
    lines.push(`Worst hour (user's local time): ${String(stats.worstHour).padStart(2, "0")}:00`);
  }
  if (stats.topEmotions.length > 0) {
    const emotionStr = stats.topEmotions.map((e) => `${e.emotion} (${e.count})`).join(", ");
    lines.push(`Top emotions: ${emotionStr}`);
  }
  lines.push(``, `Write the JSON review now.`);
  return lines.join("\n");
}

/**
 * Parse the AI response into { summary, suggestions }. Tolerates markdown
 * fences. Returns null when the response isn't parseable JSON with the
 * right shape.
 */
export function parseWeeklyReviewResponse(text: string): WeeklyReviewOutput | null {
  try {
    // Strip markdown fences if present.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      summary?: unknown;
      suggestions?: unknown;
    };
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.suggestions)) {
      return null;
    }
    const suggestions = parsed.suggestions.filter((s): s is string => typeof s === "string");
    if (suggestions.length === 0) return null;
    return {
      summary: parsed.summary,
      suggestions,
      source: "ai",
    };
  } catch {
    return null;
  }
}

// ─── Rule-based fallback (mirrors Phase 9 insights) ─────────────────────────

/**
 * Rule-based fallback review — used when the Anthropic API fails after
 * retries, or the user hasn't opted in. Mirrors the Phase 9
 * `computeInsights` approach: deterministic, rule-based findings.
 *
 * The disclaimer is appended to every review (AI or fallback).
 */
export function buildFallbackReview(stats: WeeklyStatsInput): WeeklyReviewOutput {
  const summaryParts: string[] = [];
  const suggestions: string[] = [];

  // Summary.
  const plDirection = stats.netPL > 0 ? "profitable" : stats.netPL < 0 ? "losing" : "break-even";
  summaryParts.push(
    `You were ${plDirection} this week with ${stats.netPL.toFixed(2)} net P/L across ${stats.totalTrades} trades (${(stats.winRate * 100).toFixed(1)}% win rate).`,
  );
  if (stats.tiltEvents > 0) {
    summaryParts.push(
      `You recorded ${stats.tiltEvents} tilt event${stats.tiltEvents === 1 ? "" : "s"} — worth reviewing what triggered them.`,
    );
  } else {
    summaryParts.push(`No tilt events — good emotional control.`);
  }
  if (stats.ruleBreaches > 0) {
    summaryParts.push(
      `${stats.ruleBreaches} rule breach${stats.ruleBreaches === 1 ? "" : "es"} (lockout/warning overrides) this week.`,
    );
  } else {
    summaryParts.push(`No rule breaches — you stayed within your risk limits.`);
  }

  // Suggestions (deterministic rules mirroring Phase 9).
  if (
    stats.worstStrategy &&
    stats.worstStrategy.expectancyPerTrade < 0 &&
    stats.worstStrategy.trades >= 5
  ) {
    suggestions.push(
      `Your "${stats.worstStrategy.name}" strategy had negative expectancy (${stats.worstStrategy.expectancyPerTrade.toFixed(2)}/trade over ${stats.worstStrategy.trades} trades) — consider pausing it and reviewing the setup criteria.`,
    );
  }
  if (stats.tiltEvents > 0) {
    suggestions.push(
      `You had ${stats.tiltEvents} tilt event${stats.tiltEvents === 1 ? "" : "s"} this week — try a hard 15-minute cooldown after 2 consecutive losses to break the tilt loop.`,
    );
  }
  if (stats.avgDisciplineScore != null && stats.avgDisciplineScore < 80) {
    suggestions.push(
      `Your average discipline score was ${stats.avgDisciplineScore.toFixed(0)}/100 — aim for 80+ by completing the pre-trade checklist and running a daily balance check.`,
    );
  }
  if (stats.worstHour != null) {
    suggestions.push(
      `Your worst hour was ${String(stats.worstHour).padStart(2, "0")}:00 local time — consider avoiding trading in that window next week.`,
    );
  }
  if (suggestions.length < 3) {
    suggestions.push(
      `Keep logging every trade with emotion tags — the more data you record, the sharper next week's insights will be.`,
    );
  }

  return {
    summary: summaryParts.join(" "),
    suggestions: suggestions.slice(0, 3),
    source: "fallback",
  };
}

/**
 * The disclaimer appended to every review (AI or fallback).
 */
export const REVIEW_DISCLAIMER =
  "This review describes past performance only. Past results don't guarantee future outcomes — it is not financial advice.";

// ─── Orchestrator with retries + fallback ─────────────────────────────────────

/**
 * Generate the weekly review with retries + fallback:
 *   1. Try the AI client (up to 3 attempts with exponential backoff on 429).
 *   2. Parse the response; on unparseable output, treat as failure.
 *   3. On total failure, fall back to the rule-based review.
 *
 * `sleepFn` is injectable for tests (default: real setTimeout).
 */
export async function generateWeeklyReviewWithFallback(
  stats: WeeklyStatsInput,
  client: AnthropicClient | null,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<WeeklyReviewOutput> {
  if (client) {
    const prompt = buildWeeklyStatsPrompt(stats);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const text = await client.complete(prompt, REVIEW_SYSTEM_PROMPT);
        const parsed = parseWeeklyReviewResponse(text);
        if (parsed) {
          return {
            ...parsed,
            summary: `${parsed.summary}\n\n${REVIEW_DISCLAIMER}`,
          };
        }
        // Unparseable — treat as a failure and retry.
      } catch (e) {
        if (e instanceof RateLimitError && attempt < maxAttempts) {
          // Exponential backoff: 1s, 2s.
          await sleepFn(1000 * Math.pow(2, attempt - 1));
          continue;
        }
        // Non-rate-limit error or final attempt → break to fallback.
        break;
      }
    }
  }
  // Fallback.
  const fallback = buildFallbackReview(stats);
  return {
    ...fallback,
    summary: `${fallback.summary}\n\n${REVIEW_DISCLAIMER}`,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _client: AnthropicClient | null | undefined;

/**
 * Resolve the Anthropic client:
 *   1. Test-registered client via `setAnthropicClient`.
 *   2. `RealAnthropicClient` when ANTHROPIC_API_KEY is set.
 *   3. null (no AI — always use the fallback).
 */
export function getAnthropicClient(): AnthropicClient | null {
  if (_client !== undefined) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length > 0) {
    _client = new RealAnthropicClient(apiKey);
  } else {
    _client = null;
  }
  return _client;
}

/**
 * Test-only: register a custom Anthropic client (or null to force fallback).
 */
export function setAnthropicClient(client: AnthropicClient | null): void {
  _client = client;
}
