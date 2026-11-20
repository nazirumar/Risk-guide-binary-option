/**
 * Phase 30.1 — pure dedupe helpers for harvested news.
 *
 * Three layers, in order of cost:
 *   1. Exact URL / source+URL match (cheap, handled by the DB unique index).
 *   2. Content hash of normalized title + leading raw text.
 *   3. Token-similarity of titles (catches syndicated copies with new URLs).
 *
 * The hash is FNV-1a — a fast, deterministic, non-cryptographic fingerprint.
 * It is NOT used for security, only for idempotency.
 */

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Idempotency key for an article body. Leading text keeps it stable. */
export function contentHashFor(title: string, rawText: string): string {
  return fnv1a(`${normalizeTitle(title)}\n${normalizeText(rawText.slice(0, 4000))}`);
}

/** Token Jaccard similarity in [0, 1]. Pure and symmetric. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type Dedupable = {
  title: string;
  url?: string | null;
  contentHash?: string;
};

/**
 * Return only the first occurrence of each item, compare by:
 *   normalized URL → content hash → title similarity >= threshold.
 *
 * `existing` rows (from the DB) are treated as already-seen and suppress new
 * candidates. Active items are de-duped against each other too.
 */
export function dedupeCandidates<T extends Dedupable>(
  candidates: T[],
  existing: Dedupable[] = [],
  similarityThreshold = 0.88,
): T[] {
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const seenTitles: string[] = [];

  const register = (item: Dedupable) => {
    if (item.url) seenUrls.add(normalizeText(item.url));
    if (item.contentHash) seenHashes.add(item.contentHash);
    seenTitles.push(normalizeTitle(item.title));
  };

  for (const row of existing) register(row);

  const out: T[] = [];
  for (const item of candidates) {
    const url = item.url ? normalizeText(item.url) : "";
    const hash = item.contentHash ?? contentHashFor(item.title, "");
    if ((url && seenUrls.has(url)) || seenHashes.has(hash)) continue;
    const title = normalizeTitle(item.title);
    if (seenTitles.some((s) => titleSimilarity(s, title) >= similarityThreshold)) continue;
    out.push(item);
    register({ ...item, contentHash: hash });
  }
  return out;
}
