/**
 * Phase 30.1 — static allowlist for the agentic news pipeline.
 *
 * Pure data + helpers. No network calls, no Next.js imports, no Prisma —
 * the market worker imports this file directly with a relative path.
 *
 * SECURITY (rule #11 + the Phase 30 spec):
 *   - Only the domains below may ever be fetched. User-supplied URLs are
 *     NEVER accepted by the agent.
 *   - Official central-bank sources are listed first; trading-site pages
 *     are optional and are skipped when robots.txt disallows them.
 *   - `robotsAllowed` is a small, dependency-free parser for the common
 *     User-agent / Allow / Disallow directives (good enough for an allowlist;
 *     unknown directives are ignored conservatively).
 */

export type NewsSourceKind = "api" | "page";
export type NewsSourceParser = "rss" | "html-links";

export type NewsSource = {
  /** Stable id — stored as `NewsArticle.source`. */
  id: string;
  label: string;
  kind: NewsSourceKind;
  /** Listing/feed URL. Article URLs are discovered from this page only. */
  url: string;
  domain: string;
  cadenceMinutes: number;
  parser: NewsSourceParser;
  /** Max discovered article links to follow from this listing per run. */
  maxLinks: number;
};

/**
 * Fixed, identifying User-Agent. Do not make this configurable per request —
 * a stable UA lets operators identify and rate-limit the crawler.
 */
export const NEWS_AGENT_USER_AGENT =
  "RiskGuardBot/1.0 (+https://riskguard.app; contact: support@riskguard.app)";

/** Official sources first; trading sites are behind the same allowlist. */
export const NEWS_SOURCES: NewsSource[] = [
  {
    id: "fed",
    label: "Federal Reserve",
    kind: "page",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    domain: "federalreserve.gov",
    cadenceMinutes: 30,
    parser: "rss",
    maxLinks: 6,
  },
  {
    id: "ecb",
    label: "European Central Bank",
    kind: "page",
    url: "https://www.ecb.europa.eu/rss/press.html",
    domain: "ecb.europa.eu",
    cadenceMinutes: 30,
    parser: "rss",
    maxLinks: 6,
  },
  {
    id: "boe",
    label: "Bank of England",
    kind: "page",
    url: "https://www.bankofengland.co.uk/rss/news",
    domain: "bankofengland.co.uk",
    cadenceMinutes: 30,
    parser: "rss",
    maxLinks: 6,
  },
  {
    id: "forexfactory",
    label: "ForexFactory",
    kind: "page",
    url: "https://www.forexfactory.com/news.php",
    domain: "forexfactory.com",
    cadenceMinutes: 60,
    parser: "html-links",
    maxLinks: 6,
  },
  {
    id: "investing",
    label: "Investing.com",
    kind: "page",
    url: "https://www.investing.com/news/forex-news",
    domain: "investing.com",
    cadenceMinutes: 60,
    parser: "html-links",
    maxLinks: 6,
  },
];

/**
 * Resolve enabled sources from `NEWS_AGENT_SOURCES` (comma-separated ids).
 * Empty/unset = all allowlisted sources. Unknown ids are ignored — a typo
 * must never widen the allowlist.
 */
export function getEnabledSources(): NewsSource[] {
  const raw = process.env.NEWS_AGENT_SOURCES?.trim();
  if (!raw) return NEWS_SOURCES.slice();
  const ids = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return NEWS_SOURCES.filter((s) => ids.has(s.id));
}

/** Is `url` on an allowlisted domain? Used before EVERY discovered fetch. */
export function isAllowedUrl(url: string, sources: NewsSource[] = NEWS_SOURCES): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return sources.some(
    (s) => host === s.domain.toLowerCase() || host.endsWith(`.${s.domain.toLowerCase()}`),
  );
}

/**
 * Small robots.txt evaluator.
 * Returns true when `path` may be fetched by `userAgent`.
 *  - A group matches when its User-agent token is `*` or appears in `userAgent`.
 *  - Longest matching `Allow` wins over `Disallow`; an empty `Disallow:`
 *    directive means "allow everything".
 *  - Unreachable robots.txt is handled by the caller (skip the source).
 */
export function robotsAllowed(robotsTxt: string, path: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const groups: { agents: string[]; rules: { type: "allow" | "disallow"; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      if (!current) {
        current = { agents: ["*"], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: key, path: value });
    }
  }

  let allowed = true;
  let bestLength = -1;
  for (const group of groups) {
    if (!group.agents.some((agent) => agent === "*" || ua.includes(agent))) continue;
    for (const rule of group.rules) {
      if (!rule.path) continue; // empty Disallow = allow all
      if (!path.startsWith(rule.path)) continue;
      if (rule.path.length > bestLength) {
        bestLength = rule.path.length;
        allowed = rule.type === "allow";
      }
    }
  }
  return allowed;
}
