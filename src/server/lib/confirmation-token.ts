/**
 * Phase 17 — Signed pre-trade confirmation tokens.
 *
 * The confirmation modal's cooldown ("Confirm trade" disabled for N seconds)
 * must be enforced SERVER-SIDE, not just as a disabled button. This module
 * issues an HMAC-SHA256-signed token when the user presses "Save trade" and
 * the risk + tilt checks pass. The token:
 *
 *   1. Binds the exact trade parameters (account, asset, direction, stake,
 *      payout, expiry) — the confirmed trade cannot differ from the reviewed
 *      trade without failing verification.
 *   2. Carries `notBefore` (issuedAt + cooldownSeconds) — `createTradeAction`
 *      rejects the save while `now < notBefore` when `enforceCooldown` is set.
 *   3. Carries `expiresAt` (issuedAt + TTL) — stale confirmations are rejected
 *      so market conditions can't silently drift for minutes.
 *   4. Is bound to the issuing userId — tokens can't be replayed across users.
 *
 * Stateless (no DB row) — signature + expiry do all the work. The signing
 * secret is NEXTAUTH_SECRET (same secret that protects session JWTs).
 */
import crypto from "node:crypto";
import Decimal from "decimal.js";

export const CONFIRMATION_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type ConfirmedTradeParams = {
  tradingAccountId: string;
  asset: string;
  direction: string; // "CALL" | "PUT"
  /** Normalized 2dp string. */
  stake: string;
  /** Normalized 4dp string. */
  payoutPercent: string;
  expiryMinutes: number;
};

export type TradeConfirmationPayload = {
  /** Random token id — goes into the audit log meta. */
  jti: string;
  userId: string;
  issuedAt: number; // epoch ms
  /** Cooldown ends at this instant — the save is rejected before it. */
  notBefore: number; // epoch ms
  expiresAt: number; // epoch ms
  /** false when the confirmation UI is skipped (DEMO + user setting) — cooldown not enforced. */
  enforceCooldown: boolean;
  trade: ConfirmedTradeParams;
};

export type TokenVerification =
  | { ok: true; payload: TradeConfirmationPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_USER" };

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing NEXTAUTH_SECRET — cannot sign pre-trade confirmation tokens. Set it in .env (NextAuth already requires it).",
    );
  }
  return secret;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
}

/** Normalize a stake/payout value the same way on issue and verify. */
function normalizeDecimal(
  v: FormDataEntryValue | string | number | null,
  places: number,
): string | null {
  if (v === null || v === undefined) return null;
  try {
    // toFixed keeps trailing zeros ("10" → "10.00") so issue/verify produce
    // byte-identical strings for the same numeric value.
    return new Decimal(String(v)).toDecimalPlaces(places).toFixed(places);
  } catch {
    return null;
  }
}

export function issueTradeConfirmationToken(input: {
  userId: string;
  trade: ConfirmedTradeParams;
  cooldownSeconds: number;
  enforceCooldown: boolean;
  now?: Date;
}): { token: string; payload: TradeConfirmationPayload } {
  const nowMs = (input.now ?? new Date()).getTime();
  const payload: TradeConfirmationPayload = {
    jti: crypto.randomBytes(9).toString("base64url"),
    userId: input.userId,
    issuedAt: nowMs,
    notBefore: nowMs + Math.max(0, input.cooldownSeconds) * 1000,
    expiresAt: nowMs + CONFIRMATION_TOKEN_TTL_MS,
    enforceCooldown: input.enforceCooldown,
    trade: input.trade,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token: `${body}.${sign(body)}`, payload };
}

export function verifyTradeConfirmationToken(
  token: string,
  userId: string,
  now: Date = new Date(),
): TokenVerification {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "MALFORMED" };
  }
  const [body, sig] = parts;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let payload: TradeConfirmationPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as TradeConfirmationPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.trade ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.notBefore !== "number" ||
    typeof payload.userId !== "string"
  ) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (payload.userId !== userId) {
    return { ok: false, reason: "WRONG_USER" };
  }
  if (now.getTime() > payload.expiresAt) {
    return { ok: false, reason: "EXPIRED" };
  }
  return { ok: true, payload };
}

/**
 * Server-side cooldown check. Returns the ms still remaining (0 = satisfied).
 * When the token was issued with enforceCooldown=false (confirmation UI was
 * skipped for a DEMO account), the cooldown never blocks.
 */
export function cooldownRemainingMs(
  payload: TradeConfirmationPayload,
  now: Date = new Date(),
): number {
  if (!payload.enforceCooldown) return 0;
  return Math.max(0, payload.notBefore - now.getTime());
}

/**
 * Verify the FormData trade parameters still match the reviewed trade encoded
 * in the token. Any mismatch → the user must review again (re-prepare).
 * Stake/payout are compared as Decimals at the same precision used at issue.
 */
export function formDataMatchesToken(
  formData: FormData,
  trade: ConfirmedTradeParams,
): { match: boolean; field?: string } {
  const fields: [string, string][] = [
    ["tradingAccountId", trade.tradingAccountId],
    ["asset", trade.asset],
    ["direction", trade.direction],
  ];
  for (const [key, expected] of fields) {
    const actual = formData.get(key);
    if (actual === null || String(actual) !== expected) {
      return { match: false, field: key };
    }
  }
  const stake = normalizeDecimal(formData.get("stake"), 2);
  if (stake === null || !new Decimal(stake).eq(new Decimal(trade.stake))) {
    return { match: false, field: "stake" };
  }
  const payout = normalizeDecimal(formData.get("payoutPercent"), 4);
  if (payout === null || !new Decimal(payout).eq(new Decimal(trade.payoutPercent))) {
    return { match: false, field: "payoutPercent" };
  }
  const expiry = Number(formData.get("expiryMinutes"));
  if (!Number.isFinite(expiry) || Math.trunc(expiry) !== trade.expiryMinutes) {
    return { match: false, field: "expiryMinutes" };
  }
  return { match: true };
}

/** Extract + normalize the trade params from a FormData for token issuance. */
export function extractTradeParams(formData: FormData): ConfirmedTradeParams | null {
  const tradingAccountId = formData.get("tradingAccountId");
  const asset = formData.get("asset");
  const direction = formData.get("direction");
  const expiryRaw = Number(formData.get("expiryMinutes"));
  const stake = normalizeDecimal(formData.get("stake"), 2);
  const payout = normalizeDecimal(formData.get("payoutPercent"), 4);
  if (
    !tradingAccountId ||
    !asset ||
    (direction !== "CALL" && direction !== "PUT") ||
    !Number.isFinite(expiryRaw) ||
    expiryRaw < 1 ||
    stake === null ||
    payout === null
  ) {
    return null;
  }
  return {
    tradingAccountId: String(tradingAccountId),
    asset: String(asset),
    direction: String(direction),
    stake,
    payoutPercent: payout,
    expiryMinutes: Math.trunc(expiryRaw),
  };
}
