/**
 * Phase 17 — Confirmation token unit tests.
 *
 * The cooldown must be enforced SERVER-SIDE (not only a CSS-disabled button).
 * These tests pin the token contract: roundtrip, tamper rejection, expiry,
 * user binding, cooldown math, and FormData payload matching.
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.NEXTAUTH_SECRET ??= "riskguard-test-secret-for-vitest-only";

import {
  issueTradeConfirmationToken,
  verifyTradeConfirmationToken,
  cooldownRemainingMs,
  formDataMatchesToken,
  extractTradeParams,
  CONFIRMATION_TOKEN_TTL_MS,
} from "@/server/lib/confirmation-token";
import type { ConfirmedTradeParams } from "@/server/lib/confirmation-token";

const TRADE: ConfirmedTradeParams = {
  tradingAccountId: "acc_123",
  asset: "EUR/USD",
  direction: "CALL",
  stake: "10.00",
  payoutPercent: "0.85",
  expiryMinutes: 5,
};

function buildFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("tradingAccountId", TRADE.tradingAccountId);
  fd.set("asset", TRADE.asset);
  fd.set("direction", TRADE.direction);
  fd.set("stake", TRADE.stake);
  fd.set("payoutPercent", TRADE.payoutPercent);
  fd.set("expiryMinutes", String(TRADE.expiryMinutes));
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeAll(() => {
  if (!process.env.NEXTAUTH_SECRET) {
    throw new Error("NEXTAUTH_SECRET must be set before importing the token module");
  }
});

describe("issue + verify roundtrip", () => {
  it("verifies a freshly issued token", () => {
    const { token, payload } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 5,
      enforceCooldown: true,
      now: new Date(1_000_000),
    });
    expect(payload.notBefore).toBe(1_000_000 + 5_000);
    expect(payload.expiresAt).toBe(1_000_000 + CONFIRMATION_TOKEN_TTL_MS);
    expect(payload.enforceCooldown).toBe(true);
    expect(payload.trade).toEqual(TRADE);
    expect(payload.jti).toBeTruthy();

    const v = verifyTradeConfirmationToken(token, "u1", new Date(1_000_000 + 1_000));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.jti).toBe(payload.jti);
  });

  it("gives every token a unique jti", () => {
    const a = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
    });
    const b = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
    });
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });
});

describe("tamper + misuse rejection", () => {
  it("rejects a modified payload (stake changed after review)", () => {
    const { token } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 5,
      enforceCooldown: true,
    });
    const [body] = token.split(".");
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    parsed.trade.stake = "9999.00";
    const forgedBody = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
    const forged = `${forgedBody}.${token.split(".")[1]}`;
    const v = verifyTradeConfirmationToken(forged, "u1");
    expect(v).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a token signed for a different user (replay across users)", () => {
    const { token } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
    });
    const v = verifyTradeConfirmationToken(token, "attacker");
    expect(v).toMatchObject({ ok: false, reason: "WRONG_USER" });
  });

  it("rejects an expired token", () => {
    const { token } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
      now: new Date(0),
    });
    const v = verifyTradeConfirmationToken(token, "u1", new Date(CONFIRMATION_TOKEN_TTL_MS + 1));
    expect(v).toMatchObject({ ok: false, reason: "EXPIRED" });
  });

  it("accepts a token at the exact expiry instant (boundary)", () => {
    const { token } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
      now: new Date(0),
    });
    const v = verifyTradeConfirmationToken(token, "u1", new Date(CONFIRMATION_TOKEN_TTL_MS));
    expect(v.ok).toBe(true);
  });

  it("rejects malformed tokens (no signature, garbage, empty)", () => {
    expect(verifyTradeConfirmationToken("", "u1")).toMatchObject({
      ok: false,
      reason: "MALFORMED",
    });
    expect(verifyTradeConfirmationToken("not-a-token", "u1")).toMatchObject({
      ok: false,
      reason: "MALFORMED",
    });
    expect(verifyTradeConfirmationToken("a.b.c", "u1")).toMatchObject({
      ok: false,
      reason: "MALFORMED",
    });
    const { token } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: false,
    });
    expect(verifyTradeConfirmationToken(`${token}x`, "u1")).toMatchObject({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });
});

describe("server-side cooldown enforcement", () => {
  it("reports remaining ms while the cooldown is active", () => {
    const { payload } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 5,
      enforceCooldown: true,
      now: new Date(0),
    });
    expect(cooldownRemainingMs(payload, new Date(2_000))).toBe(3_000);
    expect(cooldownRemainingMs(payload, new Date(4_999))).toBe(1);
  });

  it("is satisfied exactly at notBefore (boundary)", () => {
    const { payload } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 5,
      enforceCooldown: true,
      now: new Date(0),
    });
    expect(cooldownRemainingMs(payload, new Date(5_000))).toBe(0);
  });

  it("never blocks when enforceCooldown is false (DEMO skip path)", () => {
    const { payload } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 15,
      enforceCooldown: false,
      now: new Date(0),
    });
    expect(cooldownRemainingMs(payload, new Date(0))).toBe(0);
  });

  it("treats a 0-second cooldown as immediately satisfied", () => {
    const { payload } = issueTradeConfirmationToken({
      userId: "u1",
      trade: TRADE,
      cooldownSeconds: 0,
      enforceCooldown: true,
      now: new Date(0),
    });
    expect(cooldownRemainingMs(payload, new Date(0))).toBe(0);
  });
});

describe("formDataMatchesToken", () => {
  it("matches when the form data equals the reviewed trade", () => {
    expect(formDataMatchesToken(buildFormData(), TRADE)).toEqual({ match: true });
  });

  it("matches despite cosmetic decimal differences (10 vs 10.00)", () => {
    expect(formDataMatchesToken(buildFormData({ stake: "10" }), TRADE)).toEqual({ match: true });
    expect(formDataMatchesToken(buildFormData({ payoutPercent: "0.8500" }), TRADE)).toEqual({
      match: true,
    });
  });

  it("detects a changed stake / asset / direction / expiry / account", () => {
    expect(formDataMatchesToken(buildFormData({ stake: "11" }), TRADE).field).toBe("stake");
    expect(formDataMatchesToken(buildFormData({ asset: "BTC/USD" }), TRADE).field).toBe("asset");
    expect(formDataMatchesToken(buildFormData({ direction: "PUT" }), TRADE).field).toBe(
      "direction",
    );
    expect(formDataMatchesToken(buildFormData({ expiryMinutes: "15" }), TRADE).field).toBe(
      "expiryMinutes",
    );
    expect(formDataMatchesToken(buildFormData({ tradingAccountId: "other" }), TRADE).field).toBe(
      "tradingAccountId",
    );
  });

  it("rejects non-numeric stake", () => {
    expect(formDataMatchesToken(buildFormData({ stake: "abc" }), TRADE).match).toBe(false);
  });
});

describe("extractTradeParams", () => {
  it("extracts and normalizes the trade params from FormData", () => {
    const fd = buildFormData({ stake: "12.345", payoutPercent: ".85" });
    expect(extractTradeParams(fd)).toEqual({
      tradingAccountId: "acc_123",
      asset: "EUR/USD",
      direction: "CALL",
      stake: "12.35",
      payoutPercent: "0.8500",
      expiryMinutes: 5,
    });
  });

  it("returns null for invalid input (bad direction, missing fields)", () => {
    expect(extractTradeParams(buildFormData({ direction: "SIDEWAYS" }))).toBeNull();
    const empty = new FormData();
    expect(extractTradeParams(empty)).toBeNull();
  });
});
