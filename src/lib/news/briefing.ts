/**
 * Phase 30.4 — pure news-briefing copy builder.
 *
 * No Next.js, Prisma or provider imports: the cron composes inputs (all
 * precomputed rows) and this module turns them into short, descriptive copy.
 * Every briefing ends with the visible risk disclaimer, and any text that
 * slips into signal/promise language is replaced with a safe fallback before
 * it can be stored or sent.
 */
import { containsBannedCoachLanguage } from "../ai/coach";

export const BRIEFING_DISCLAIMER =
  "Information only — not financial advice. Past results do not guarantee future outcomes.";

export type BriefingInputs = {
  nextNewsTitle?: string | null;
  nextNewsCurrency?: string | null;
  nextNewsMinutesTo?: number | null;
  /** GOOD | CAUTION | AVOID, or null when the worker has no fresh data. */
  marketRating?: string | null;
  marketStale?: boolean;
  /** One short, descriptive observation from the user's own edge report. */
  edgeInsight?: string | null;
  recentHeadlines?: string[];
  generatedAt?: Date;
};

export type BriefingCopy = {
  title: string;
  body: string;
};

/** Signal/promise wording that must never appear in a briefing. */
export function containsBannedBriefingLanguage(text: string): boolean {
  return (
    containsBannedCoachLanguage(text) ||
    /\b(?:buy|sell|enter|exit|stake)\s+now\b/i.test(text) ||
    /\b(?:go|going)\s+(?:long|short)\b/i.test(text) ||
    /\b(?:open|place)\s+(?:a\s+)?trade\b/i.test(text)
  );
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/** Build a bounded, descriptive briefing. Never throws on missing inputs. */
export function buildNewsBriefing(inputs: BriefingInputs = {}): BriefingCopy {
  const generatedAt = inputs.generatedAt instanceof Date ? inputs.generatedAt : new Date();
  const lines: string[] = [];

  const newsTitle = clip(inputs.nextNewsTitle, 160);
  if (newsTitle) {
    const currency = clip(inputs.nextNewsCurrency, 12);
    const minutes = Number(inputs.nextNewsMinutesTo);
    const timing =
      Number.isFinite(minutes) && minutes >= 0
        ? ` in about ${Math.max(1, Math.round(minutes))} minutes`
        : "";
    lines.push(`Next high-impact item: ${currency ? `${currency} ` : ""}${newsTitle}${timing}.`);
  } else {
    lines.push("No upcoming high-impact event is on the calendar.");
  }

  const rating = clip(inputs.marketRating, 20);
  if (rating && ["GOOD", "CAUTION", "AVOID"].includes(rating.toUpperCase())) {
    lines.push(
      `Latest market rating: ${rating.toUpperCase()}${inputs.marketStale ? " (data feed delayed)" : ""}.`,
    );
  } else {
    lines.push("Market rating: no current data available.");
  }

  const insight = clip(inputs.edgeInsight, 220);
  if (insight) lines.push(`From your journal: ${insight}`);

  const headlines = (inputs.recentHeadlines ?? [])
    .map((h) => clip(h, 120))
    .filter((h): h is string => Boolean(h))
    .slice(0, 2);
  if (headlines.length) lines.push(`Recent headlines: ${headlines.join(" | ")}`);

  lines.push(BRIEFING_DISCLAIMER);
  return {
    title: `Your news briefing — ${generatedAt.toISOString().slice(0, 10)}`,
    body: lines.join("\n"),
  };
}

/**
 * Last line of defence: if generated or upstream text contains signal/promise
 * language, discard the commentary entirely and keep only the safe notice.
 */
export function sanitizeBriefingCopy(copy: BriefingCopy): BriefingCopy {
  if (!containsBannedBriefingLanguage(`${copy.title}\n${copy.body}`)) return copy;
  return {
    title: "Your news briefing",
    body: `Your scheduled briefing is ready. Additional commentary was withheld because it did not meet the descriptive-language rules.\n${BRIEFING_DISCLAIMER}`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain HTML for the optional email channel (no external template engine). */
export function briefingEmailHtml(copy: BriefingCopy): string {
  return `<div style="font-family:system-ui,Segoe,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <h1 style="font-size:20px">${escapeHtml(copy.title)}</h1>
  <p style="white-space:pre-line;font-size:14px;line-height:1.5">${escapeHtml(copy.body)}</p>
</div>`;
}
