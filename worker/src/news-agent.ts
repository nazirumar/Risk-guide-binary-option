/**
 * Phase 30.1 — bounded, agentic news ingestion. WORKER ONLY.
 *
 * This module is imported by `worker/src/index.ts`, never by the web request
 * path. The web app reads precomputed NewsArticle / NewsEvent rows only.
 *
 * The "agent" is a fixed, bounded loop:
 *   allowlisted sources → robots.txt → fetch (rate-limited) → extract →
 *   dedupe → classify (Groq via AIProvider) → upsert → AgentRun audit row.
 *
 * Page text is untrusted data. No tool is exposed to the model; nothing it
 * returns is used as a URL or an instruction. A failed run never deletes
 * cached rows (rule #11: never block trading).
 */
import type { PrismaClient } from "@prisma/client";

import { getAIProvider } from "../../src/lib/ai/provider";
import { getNewsProvider } from "../../src/lib/news/provider";
import {
  getEnabledSources,
  isAllowedUrl,
  robotsAllowed,
  NEWS_AGENT_USER_AGENT,
  type NewsSource,
} from "../../src/lib/news/sources";
import {
  extractArticleText,
  extractFeedItems,
  extractHtmlLinks,
  truncate,
} from "../../src/lib/news/extract";
import { contentHashFor, dedupeCandidates } from "../../src/lib/news/dedupe";
import {
  ARTICLE_SYSTEM_PROMPT,
  buildArticlePrompt,
  parseArticleClassification,
  ruleBasedClassification,
  type ArticleClassification,
} from "../../src/lib/news/classify";
import type { NewsImpact } from "../../src/lib/news/provider";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Off unless explicitly enabled — all AI features are opt-in by default. */
export function isNewsAgentEnabled(): boolean {
  return process.env.NEWS_AGENT_ENABLED === "true";
}

export const NEWS_AGENT_INTERVAL_MS = envInt(
  "NEWS_AGENT_INTERVAL_MS",
  30 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);

const MAX_PAGES = envInt("NEWS_AGENT_MAX_PAGES", 4, 1, 20);
const MAX_ITEMS = envInt("NEWS_AGENT_MAX_ITEMS", 20, 1, 200);
const MAX_BYTES = envInt("NEWS_AGENT_MAX_BYTES", 200_000, 1_000, 2_000_000);
const TIMEOUT_MS = envInt("NEWS_AGENT_TIMEOUT_MS", 10_000, 1_000, 60_000);
const DOMAIN_INTERVAL_MS = envInt("NEWS_AGENT_DOMAIN_INTERVAL_MS", 1_000, 0, 60_000);

type FetchResult = { ok: boolean; status: number; text: string; error?: string };

/** Stream a response but stop at MAX_BYTES so a huge page can't blow up memory. */
async function fetchTextCapped(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": NEWS_AGENT_USER_AGENT,
        Accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };

    const reader = res.body?.getReader();
    if (!reader)
      return { ok: true, status: res.status, text: (await res.text()).slice(0, MAX_BYTES) };

    const decoder = new TextDecoder();
    let text = "";
    while (text.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return { ok: true, status: res.status, text: text.slice(0, MAX_BYTES) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Per-domain minimum spacing. Shared across the whole agent run. */
const lastFetchAt = new Map<string, number>();

async function politeFetch(url: string, domain: string): Promise<FetchResult> {
  const now = Date.now();
  const previous = lastFetchAt.get(domain) ?? 0;
  const wait = DOMAIN_INTERVAL_MS - (now - previous);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastFetchAt.set(domain, Date.now());
  return fetchTextCapped(url);
}

type Candidate = {
  title: string;
  url: string;
  publishedAt: Date;
  rawText: string;
  sourceId: string;
  contentHash?: string;
};

/**
 * Refresh the economic calendar through the existing NewsProvider seam.
 * Returns counts so the AgentRun row stays informative.
 */
async function refreshCalendar(
  prisma: PrismaClient,
  errors: string[],
): Promise<{ found: number; stored: number }> {
  const provider = getNewsProvider();
  const from = new Date();
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  let events: Awaited<ReturnType<typeof provider.fetchEvents>> = [];
  try {
    events = await provider.fetchEvents({ fromUtc: from, toUtc: to });
  } catch (error) {
    errors.push(
      `calendar(${provider.name}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { found: 0, stored: 0 };
  }

  let stored = 0;
  for (const ev of events.slice(0, 500)) {
    try {
      await prisma.newsEvent.upsert({
        where: {
          source_scheduledAt_title: {
            source: provider.name,
            scheduledAt: ev.scheduledAt,
            title: ev.title,
          },
        },
        create: {
          currency: ev.currency.toUpperCase(),
          title: ev.title,
          impact: ev.impact,
          scheduledAt: ev.scheduledAt,
          source: provider.name,
          forecast: ev.forecast ?? null,
          actual: ev.actual ?? null,
          url: ev.url ?? null,
        },
        update: {
          currency: ev.currency.toUpperCase(),
          impact: ev.impact,
          forecast: ev.forecast ?? null,
          actual: ev.actual ?? null,
          url: ev.url ?? null,
        },
      });
      stored++;
    } catch {
      // One malformed row must not abort the whole calendar refresh.
    }
  }
  return { found: events.length, stored };
}

/** Check robots.txt once per domain per run. 404 means "no rules → allowed". */
async function sourceAllowed(source: NewsSource, path: string): Promise<boolean> {
  // robots.txt belongs to the exact host serving the listing, not the
  // registrable domain used for the allowlist / rate-limit key.
  const host = new URL(source.url).hostname;
  const robots = await politeFetch(`https://${host}/robots.txt`, source.domain);
  if (robots.status === 404) return true;
  if (!robots.ok) return false; // unreachable rules → skip conservatively
  return robotsAllowed(robots.text, path, NEWS_AGENT_USER_AGENT);
}

/** Fetch one listing and turn it into bounded article candidates. */
async function collectFromSource(
  source: NewsSource,
  errors: string[],
  remaining: number,
): Promise<Candidate[]> {
  if (remaining <= 0) return [];
  const out: Candidate[] = [];
  try {
    if (!(await sourceAllowed(source, new URL(source.url).pathname))) {
      console.log(`[news-agent] robots.txt disallows ${source.id} — skipping.`);
      return out;
    }
    const listing = await politeFetch(source.url, source.domain);
    if (!listing.ok) {
      errors.push(`${source.id}: listing HTTP ${listing.status}`);
      return out;
    }
    const discovered =
      source.parser === "rss"
        ? extractFeedItems(listing.text)
        : extractHtmlLinks(listing.text, source.url, source.maxLinks);

    for (const item of discovered.slice(0, Math.min(source.maxLinks, remaining))) {
      if (!isAllowedUrl(item.url)) continue; // defense in depth
      try {
        const page = item.rawText
          ? { ok: true, text: "" }
          : await politeFetch(item.url, source.domain);
        if (!page.ok) continue;
        const rawText = truncate(item.rawText || extractArticleText(page.text), 6000);
        out.push({ ...item, rawText, sourceId: source.id });
      } catch (error) {
        errors.push(
          `${source.id}: article fetch failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    errors.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

/**
 * Run one complete cycle. Safe to call on a timer: errors are recorded, not
 * thrown, and existing rows are never removed.
 */
export async function runNewsAgent(prisma: PrismaClient): Promise<void> {
  if (!isNewsAgentEnabled()) return;

  const startedAt = new Date();
  const run = await prisma.agentRun.create({
    data: { kind: "NEWS_AGENT", status: "PARTIAL", startedAt },
  });

  const errors: string[] = [];
  let itemsFound = 0;
  let itemsStored = 0;
  let providerName = "none";
  let status = "PARTIAL";

  try {
    const calendar = await refreshCalendar(prisma, errors);
    itemsFound += calendar.found;
    itemsStored += calendar.stored;

    const ai = getAIProvider();
    providerName = ai ? (ai.name ?? "ai") : "rule-based";

    const sources = getEnabledSources().slice(0, MAX_PAGES);
    const candidates: Candidate[] = [];
    for (const source of sources) {
      const collected = await collectFromSource(source, errors, MAX_ITEMS - candidates.length);
      candidates.push(...collected);
    }
    itemsFound += candidates.length;

    // Fresh-only dedupe: compare against recent rows so re-runs are idempotent.
    const existing = await prisma.newsArticle.findMany({
      where: { publishedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      select: { title: true, url: true, contentHash: true },
      take: 500,
    });
    const hashed = candidates.map((c) => ({
      ...c,
      contentHash: contentHashFor(c.title, c.rawText),
    }));
    const fresh = dedupeCandidates(hashed, existing);

    for (const item of fresh.slice(0, MAX_ITEMS)) {
      try {
        let classification: ArticleClassification | null = null;
        if (ai) {
          try {
            const raw = await ai.complete(buildArticlePrompt(item), ARTICLE_SYSTEM_PROMPT, {
              maxTokens: 400,
              temperature: 0,
            });
            classification = parseArticleClassification(raw);
            if (!classification)
              errors.push(`${sourceShort(item.url)}: unparseable AI classification`);
          } catch (error) {
            errors.push(
              `${sourceShort(item.url)}: AI failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const result = classification ?? ruleBasedClassification(item);
        if (!result.relevant || !result.summary) continue;

        const data = {
          title: truncate(item.title, 240),
          summary: result.summary,
          publishedAt: item.publishedAt,
          currency: result.currencies.slice(0, 6),
          symbols: result.symbols.slice(0, 8),
          impact: result.impact as NewsImpact,
          rawText: truncate(item.rawText, 6000),
        };
        await prisma.newsArticle.upsert({
          where: { source_url: { source: item.sourceId, url: item.url } },
          create: { ...data, source: item.sourceId, url: item.url, contentHash: item.contentHash! },
          update: { ...data },
        });
        itemsStored++;
      } catch (error) {
        errors.push(
          `store ${sourceShort(item.url)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    status = errors.length > 0 ? "PARTIAL" : "OK";
  } catch (error) {
    status = "FAILED";
    errors.push(`agent: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        provider: providerName,
        itemsFound,
        itemsStored,
        tokensUsed: 0, // the provider API does not expose usage yet
        error: errors.length > 0 ? errors.join(" | ").slice(0, 1000) : null,
        finishedAt: new Date(),
      },
    });
    console.log(
      `[news-agent] ${status}: found=${itemsFound} stored=${itemsStored} provider=${providerName} ` +
        `in ${Date.now() - startedAt.getTime()}ms`,
    );
  }
}

function sourceShort(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
