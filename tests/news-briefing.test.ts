/**
 * Phase 30.4 — pure unit tests for the scheduled news-briefing copy builder.
 *
 * No DB, no network, no AI key. Covers descriptive copy, the always-on
 * disclaimer, bounded/deduped inputs, banned-language detection and the
 * last-line-of-defence sanitizer.
 */
import { describe, expect, it } from "vitest";

import {
  BRIEFING_DISCLAIMER,
  briefingEmailHtml,
  buildNewsBriefing,
  containsBannedBriefingLanguage,
  sanitizeBriefingCopy,
} from "@/lib/news/briefing";

describe("buildNewsBriefing", () => {
  it("composes descriptive copy from all inputs and appends the disclaimer", () => {
    const copy = buildNewsBriefing({
      nextNewsTitle: "US Nonfarm Payrolls",
      nextNewsCurrency: "USD",
      nextNewsMinutesTo: 42,
      marketRating: "CAUTION",
      marketStale: false,
      edgeInsight: "Most of your EUR/USD trades were logged outside your plan.",
      recentHeadlines: ["Fed holds rates", "ECB minutes published"],
      generatedAt: new Date("2026-11-21T09:00:00.000Z"),
    });

    expect(copy.title).toBe("Your news briefing — 2026-11-21");
    expect(copy.body).toContain("USD US Nonfarm Payrolls in about 42 minutes.");
    expect(copy.body).toContain("Latest market rating: CAUTION.");
    expect(copy.body).toContain(
      "From your journal: Most of your EUR/USD trades were logged outside your plan.",
    );
    expect(copy.body).toContain("Recent headlines: Fed holds rates | ECB minutes published");
    expect(copy.body.endsWith(BRIEFING_DISCLAIMER)).toBe(true);
    expect(containsBannedBriefingLanguage(copy.body)).toBe(false);
  });

  it("tolerates missing inputs without throwing and never signals", () => {
    const copy = buildNewsBriefing();
    expect(copy.body).toContain("No upcoming high-impact event is on the calendar.");
    expect(copy.body).toContain("Market rating: no current data available.");
    expect(copy.body.endsWith(BRIEFING_DISCLAIMER)).toBe(true);
    expect(containsBannedBriefingLanguage(copy.body)).toBe(false);
  });

  it("marks stale market data and ignores unknown ratings", () => {
    const stale = buildNewsBriefing({ marketRating: "GOOD", marketStale: true });
    expect(stale.body).toContain("Latest market rating: GOOD (data feed delayed).");
    const unknown = buildNewsBriefing({ marketRating: "SOMETHING" });
    expect(unknown.body).toContain("Market rating: no current data available.");
  });

  it("caps currency, headline count and insight length", () => {
    const copy = buildNewsBriefing({
      nextNewsTitle: "CPI release",
      nextNewsCurrency: "VERYLONGCURRENCYCODE",
      edgeInsight: "x".repeat(500),
      recentHeadlines: ["one", "two", "three", "four"],
    });
    expect(copy.body).toContain("VERYLONGCURR CPI release.");
    expect(copy.body).not.toContain("ENCYCODE");
    expect(copy.body.match(/Recent headlines:/g)).toHaveLength(1);
    // two headlines max, insight clipped to 220 chars + the "From your journal:" prefix
    expect(copy.body).not.toContain("three");
    expect(copy.body).not.toContain("four");
    expect(copy.body).toContain("x".repeat(220));
    expect(copy.body).not.toContain("x".repeat(221));
  });
});

describe("containsBannedBriefingLanguage", () => {
  it("flags promises, advice and explicit trade instructions", () => {
    for (const text of [
      "This is a guaranteed win.",
      "Follow this trading signal.",
      "Buy now before the move.",
      "Go long on EUR/USD.",
      "Open a trade at 9am.",
      "You should enter this pair.",
    ]) {
      expect(containsBannedBriefingLanguage(text), text).toBe(true);
    }
  });

  it("allows the disclaimer and descriptive observations", () => {
    expect(containsBannedBriefingLanguage(BRIEFING_DISCLAIMER)).toBe(false);
    expect(containsBannedBriefingLanguage("Next high-impact item: USD CPI in 20 minutes.")).toBe(
      false,
    );
    expect(containsBannedBriefingLanguage("Latest market rating: CAUTION.")).toBe(false);
  });
});

describe("sanitizeBriefingCopy", () => {
  it("keeps safe copy unchanged", () => {
    const copy = buildNewsBriefing({ marketRating: "GOOD" });
    expect(sanitizeBriefingCopy(copy)).toEqual(copy);
  });

  it("drops signal language from upstream text and keeps only the safe notice", () => {
    const sanitized = sanitizeBriefingCopy({
      title: "Your news briefing",
      body: "Buy now — guaranteed profit.\n" + BRIEFING_DISCLAIMER,
    });
    expect(sanitized.title).toBe("Your news briefing");
    expect(sanitized.body).toContain("Additional commentary was withheld");
    expect(sanitized.body.endsWith(BRIEFING_DISCLAIMER)).toBe(true);
    expect(containsBannedBriefingLanguage(sanitized.body)).toBe(false);
  });
});

describe("briefingEmailHtml", () => {
  it("escapes HTML from untrusted upstream text", () => {
    const html = briefingEmailHtml({
      title: "Your news briefing",
      body: '<b onmouseover="x">CPI</b> & more',
    });
    expect(html).not.toContain("<b onmouseover");
    expect(html).toContain("&lt;b onmouseover=&quot;x&quot;&gt;CPI&lt;/b&gt; &amp; more");
  });
});
