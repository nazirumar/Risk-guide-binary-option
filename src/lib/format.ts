/**
 * Currency + number formatting helpers (PROJECT_RULES.md Phase 3).
 *
 * All functions accept a `currency` 3-letter ISO code (USD, EUR, NGN, etc.)
 * and use Intl.NumberFormat under the hood so output is correct for any
 * locale. Always takes the Decimal/string form (not float) — never the
 * raw Prisma Decimal object directly because Prisma returns a Decimal whose
 * toString() is locale-agnostic and safe to format.
 *
 * Money values: green for positive (profit), red for negative (loss). The
 * color choice is left to the caller via the `signed` option, which adds a
 * `+` to positives and keeps the `-` for negatives.
 */
import Decimal from "decimal.js";

export const SUPPORTED_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "NGN",
  "JPY",
  "AUD",
  "CAD",
  "ZAR",
  "GHS",
  "KES",
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

function safeCurrency(code: string | undefined | null): SupportedCurrency {
  if (code && isSupportedCurrency(code.toUpperCase())) {
    return code.toUpperCase() as SupportedCurrency;
  }
  return "USD";
}

// ─── Money formatting ─────────────────────────────────────────────────────────

/**
 * Format a money amount as `-$1,234.56` or `+$1,234.56` when `signed` is true.
 * Input can be a Decimal, a string, or a number; we coerce to string then
 * pass through Intl.NumberFormat.
 */
export function formatMoney(
  amount: Decimal | string | number | null | undefined,
  currency: string = "USD",
  opts: { signed?: boolean; locale?: string } = {},
): string {
  if (amount === null || amount === undefined) return "—";
  const cur = safeCurrency(currency);
  const value = new Decimal(amount.toString());
  const signed = opts.signed ?? false;

  // Intl.NumberFormat handles the currency symbol, grouping, decimals.
  const formatter = new Intl.NumberFormat(opts.locale ?? "en-US", {
    style: "currency",
    currency: cur,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: signed ? "always" : "negative",
  });

  // Intl may not be available with the currency during SSR — fall back.
  try {
    return formatter.format(Number(value.toFixed(2)));
  } catch {
    // Fallback — manually compose.
    const sign = value.gte(0) ? (signed ? "+" : "") : "-";
    const abs = value.abs().toFixed(2);
    return `${sign}${cur} ${abs}`;
  }
}

/**
 * Same as formatMoney but returns null for zero/undefined (useful for showing
 * "—" in tables when there's no P/L yet).
 */
export function formatMoneyOrDash(
  amount: Decimal | string | number | null | undefined,
  currency: string = "USD",
): string {
  if (amount === null || amount === undefined) return "—";
  const value = new Decimal(amount.toString());
  if (value.isZero()) return "—";
  return formatMoney(value, currency, { signed: true });
}

// ─── Number formatting ───────────────────────────────────────────────────────

export function formatNumber(
  value: number | Decimal | string | null | undefined,
  opts: { decimals?: number; locale?: string } = {},
): string {
  if (value === null || value === undefined) return "—";
  const v = new Decimal(value.toString());
  const formatter = new Intl.NumberFormat(opts.locale ?? "en-US", {
    minimumFractionDigits: opts.decimals ?? 0,
    maximumFractionDigits: opts.decimals ?? 2,
  });
  try {
    return formatter.format(Number(v.toFixed(opts.decimals ?? 2)));
  } catch {
    return v.toFixed(opts.decimals ?? 2);
  }
}

// ─── Percent formatting ─────────────────────────────────────────────────────

/**
 * Format a percentage. Accepts either:
 *   - a fraction (0.85 → "85.00%"), or
 *   - a whole-number percentage (85 → "85.00%") when `alreadyPercent` is true.
 *
 * For win-rate / payout / risk-percent fields, callers pass the fraction form.
 */
export function formatPercent(
  value: number | Decimal | string | null | undefined,
  opts: { alreadyPercent?: boolean; decimals?: number; signed?: boolean } = {},
): string {
  if (value === null || value === undefined) return "—";
  const v = new Decimal(value.toString());
  const pct = opts.alreadyPercent ? v : v.mul(100);
  const formatted = pct.toFixed(opts.decimals ?? 2);
  const sign = opts.signed && pct.gte(0) ? "+" : "";
  return `${sign}${formatted}%`;
}

// ─── Date formatting ─────────────────────────────────────────────────────────

export function formatDate(
  date: Date | string | null | undefined,
  opts: { withTime?: boolean; locale?: string } = {},
): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(opts.locale ?? "en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    ...(opts.withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}

export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (sec < 60) return rtf.format(-sec, "second");
  if (min < 60) return rtf.format(-min, "minute");
  if (hr < 24) return rtf.format(-hr, "hour");
  if (day < 30) return rtf.format(-day, "day");
  return formatDate(d);
}

// ─── Direction labels ────────────────────────────────────────────────────────

export function formatDirection(d: "CALL" | "PUT" | string): string {
  if (d === "CALL") return "CALL";
  if (d === "PUT") return "PUT";
  return d;
}

export function formatResult(r: string): string {
  return r.charAt(0).toUpperCase() + r.slice(1).toLowerCase();
}
