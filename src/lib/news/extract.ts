/**
 * Phase 30.1 — pure extraction helpers for harvested news pages/feeds.
 *
 * No network, no Next.js imports, no Prisma. The worker imports this file
 * directly. All functions are deterministic given their input so they can be
 * unit-tested without a DB.
 *
 * IMPORTANT: text returned here is UNTRUSTED DATA. It is fed to the AI
 * classifier as data only (see classify.ts) and is never interpreted as
 * instructions, tool calls, or URLs to fetch.
 */

import { isIso4217Currency } from "./warning";

export type RawCandidate = {
  title: string;
  url: string;
  publishedAt: Date;
  /** Plain text (HTML stripped, entities decoded, length-capped upstream). */
  rawText: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

/** Decode the small set of entities that appear in RSS/HTML headlines. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith("#x")) {
        const n = Number.parseInt(code.slice(2), 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      if (code.startsWith("#")) {
        const n = Number.parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .trim();
}

/** Strip scripts/styles/tags and decode entities. Pure, bounded by caller. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
}

/** Truncate to `max` chars without cutting a surrogate pair in half. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, Math.max(0, max - 1));
  return sliced.endsWith(String.fromCharCode(0xd83d)) ? `${sliced.slice(0, -1)}…` : `${sliced}…`;
}

function readTag(block: string, names: string[]): string {
  for (const name of names) {
    // Accept namespaced RSS tags such as <content:encoded> / <dc:date>.
    const tag = `(?:[a-z]+:)?${name}`;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = block.match(re);
    if (m?.[1]) {
      const value = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
      const decoded = decodeEntities(stripHtml(value));
      if (decoded) return decoded;
    }
    // Atom-style self-closing link: <link href="..." />
    const href = block.match(new RegExp(`<${tag}\\b[^>]*href=["']([^"']+)["']`, "i"));
    if (href?.[1]) return decodeEntities(href[1]);
  }
  return "";
}

function parseDate(raw: string): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
}

/**
 * Parse RSS 2.0 `<item>` and Atom `<entry>` blocks into raw candidates.
 * Titles/URLs are capped by the caller after this function returns.
 */
export function extractFeedItems(xml: string): RawCandidate[] {
  const blocks = xml.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  const out: RawCandidate[] = [];
  for (const block of blocks) {
    const title = readTag(block, ["title"]);
    let url = readTag(block, ["link", "guid"]);
    if (!url) {
      const guid = readTag(block, ["guid"]);
      if (guid.startsWith("http")) url = guid;
    }
    const rawText = readTag(block, ["description", "content", "summary", "encoded"]);
    if (!title || !url) continue;
    out.push({
      title: truncate(title, 240),
      url,
      publishedAt: parseDate(readTag(block, ["pubDate", "published", "updated", "date"])),
      rawText: truncate(rawText, 6000),
    });
  }
  return out;
}

/**
 * Extract article links from an HTML listing page. Relative URLs are resolved
 * against the listing URL. Keeps only http(s) links with a readable title.
 */
export function extractHtmlLinks(html: string, baseUrl: string, limit: number): RawCandidate[] {
  const out: RawCandidate[] = [];
  const anchors = html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const anchor of anchors) {
    if (out.length >= limit) break;
    const href = anchor.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(href), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = truncate(stripHtml(anchor), 240);
    if (title.length < 12) continue;
    out.push({ title, url, publishedAt: new Date(), rawText: "" });
  }
  return out;
}

/** Best-effort main-content extraction: prefer <article>, else <body>, else all. */
export function extractArticleText(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  return truncate(stripHtml(article ?? html), 6000);
}

/** ISO 4217 currencies explicitly mentioned in the text (max 6, stable order). */
export function detectCurrencies(text: string): string[] {
  const found = new Set<string>();
  for (const token of text.match(/\b[A-Z]{3}\b/g) ?? []) {
    if (isIso4217Currency(token)) found.add(token);
    if (found.size >= 6) break;
  }
  return [...found];
}

/** Obvious market symbols ($EURUSD, EUR/USD, XAU/USD, $SPY). Max 8. */
export function detectSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.match(/\$([A-Z]{1,6})\b|\b([A-Z]{3,5}\/[A-Z]{3})\b/g) ?? []) {
    const symbol = m.replace("$", "").toUpperCase();
    if (symbol.length >= 2) found.add(symbol);
    if (found.size >= 8) break;
  }
  return [...found];
}
