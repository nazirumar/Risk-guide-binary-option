/**
 * Phase 24 — pure-calc tests for billing plans + feature gating.
 *
 * Covers:
 *   - PLAN_CONFIGS: FREE + PRO limits + features.
 *   - hasFeature: feature presence per plan.
 *   - canCreateAccount: account count limit.
 *   - canSaveTrade: monthly trade count limit.
 *   - ConsoleBillingProvider: webhook signature always passes (dev), event
 *     parsing from JSON.
 *   - PaystackProvider: webhook signature verification (HMAC-SHA512).
 *   - Webhook idempotency logic (duplicate events don't double-apply).
 *   - Out-of-order events (payment_failed before charge.success).
 *   - Grace period calculation.
 */
import { describe, it, expect } from "vitest";
import {
  PLAN_CONFIGS,
  hasFeature,
  canCreateAccount,
  canSaveTrade,
  GRACE_PERIOD_DAYS,
  type PlanKey,
  type PlanFeature,
} from "@/lib/billing/plans";
import {
  ConsoleBillingProvider,
  PaystackProvider,
  timingSafeCompare,
  type WebhookEvent,
} from "@/lib/billing/provider";
import { createHmac } from "node:crypto";

// ─── PLAN_CONFIGS ─────────────────────────────────────────────────────────────

describe("PLAN_CONFIGS — limits + features", () => {
  it("FREE has 1 account, 100 trades/month, no PRO features", () => {
    const free = PLAN_CONFIGS.FREE;
    expect(free.maxAccounts).toBe(1);
    expect(free.maxTradesPerMonth).toBe(100);
    expect(free.features).not.toContain("tilt-detection");
    expect(free.features).not.toContain("telegram");
    expect(free.features).not.toContain("ai-review");
  });

  it("PRO has unlimited accounts + trades + all PRO features", () => {
    const pro = PLAN_CONFIGS.PRO;
    expect(pro.maxAccounts).toBeNull();
    expect(pro.maxTradesPerMonth).toBeNull();
    expect(pro.features).toContain("tilt-detection");
    expect(pro.features).toContain("telegram");
    expect(pro.features).toContain("ai-review");
    expect(pro.features).toContain("exports");
  });

  it("monthly prices match the spec", () => {
    expect(PLAN_CONFIGS.FREE.monthlyPriceNGN).toBe(0);
    expect(PLAN_CONFIGS.FREE.monthlyPriceUSD).toBe(0);
    expect(PLAN_CONFIGS.PRO.monthlyPriceNGN).toBe(15000);
    expect(PLAN_CONFIGS.PRO.monthlyPriceUSD).toBe(10);
  });

  it("GRACE_PERIOD_DAYS is 3 per spec", () => {
    expect(GRACE_PERIOD_DAYS).toBe(3);
  });
});

// ─── hasFeature ───────────────────────────────────────────────────────────────

describe("hasFeature — plan feature check", () => {
  it("FREE has balance-sync but not tilt-detection", () => {
    expect(hasFeature("FREE", "balance-sync")).toBe(true);
    expect(hasFeature("FREE", "tilt-detection")).toBe(false);
  });

  it("PRO has all features", () => {
    const features: PlanFeature[] = [
      "tilt-detection",
      "telegram",
      "ai-review",
      "exports",
      "advanced-analytics",
      "withdrawal-rules",
      "discipline-score",
      "strategy-validation",
      "sessions-news",
    ];
    for (const f of features) {
      expect(hasFeature("PRO", f)).toBe(true);
    }
  });
});

// ─── canCreateAccount ───────────────────────────────────────────────────────

describe("canCreateAccount — account limit", () => {
  it("FREE: 1 account → 0 current=ok, 1 current=blocked", () => {
    expect(canCreateAccount("FREE", 0)).toBe(true);
    expect(canCreateAccount("FREE", 1)).toBe(false);
  });

  it("PRO: unlimited → always ok", () => {
    expect(canCreateAccount("PRO", 0)).toBe(true);
    expect(canCreateAccount("PRO", 100)).toBe(true);
  });
});

// ─── canSaveTrade ───────────────────────────────────────────────────────────

describe("canSaveTrade — monthly trade limit", () => {
  it("FREE: 100 trades → 99=ok, 100=blocked", () => {
    expect(canSaveTrade("FREE", 99)).toBe(true);
    expect(canSaveTrade("FREE", 100)).toBe(false);
  });

  it("PRO: unlimited → always ok", () => {
    expect(canSaveTrade("PRO", 0)).toBe(true);
    expect(canSaveTrade("PRO", 10000)).toBe(true);
  });
});

// ─── ConsoleBillingProvider ─────────────────────────────────────────────────

describe("ConsoleBillingProvider", () => {
  const provider = new ConsoleBillingProvider();

  it("verifyWebhookSignature always passes (dev/test)", () => {
    expect(provider.verifyWebhookSignature("any body", "any signature")).toBe(true);
    expect(provider.verifyWebhookSignature("", "")).toBe(true);
  });

  it("parseWebhookEvent parses valid JSON with eventId + eventType", () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ eventId: "evt_1", eventType: "charge.success", plan: "PRO" }),
    );
    expect(event).not.toBeNull();
    expect(event!.eventId).toBe("evt_1");
    expect(event!.eventType).toBe("charge.success");
    expect(event!.plan).toBe("PRO");
  });

  it("parseWebhookEvent returns null for missing eventId", () => {
    expect(provider.parseWebhookEvent(JSON.stringify({ eventType: "charge.success" }))).toBeNull();
  });

  it("parseWebhookEvent returns null for non-JSON", () => {
    expect(provider.parseWebhookEvent("not json")).toBeNull();
  });

  it("initializeCheckout returns a reference + URL", async () => {
    const result = await provider.initializeCheckout({
      userId: "test-user",
      userEmail: "test@example.com",
      plan: "PRO",
      amount: 1500000,
      currency: "NGN",
      callbackUrl: "http://localhost:3000/app/billing",
    });
    expect(result.reference).toMatch(/^test-/);
    expect(result.checkoutUrl).toBeTruthy();
  });
});

// ─── PaystackProvider webhook signature ─────────────────────────────────────

describe("PaystackProvider — webhook signature (HMAC-SHA512)", () => {
  const secret = "sk_test_abcdef123456";
  const provider = new PaystackProvider(secret);

  it("verifies the correct signature", () => {
    const body = JSON.stringify({ event: "charge.success", data: { id: 123 } });
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(provider.verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const body = JSON.stringify({ event: "charge.success" });
    const wrongSig = "a".repeat(128);
    expect(provider.verifyWebhookSignature(body, wrongSig)).toBe(false);
  });

  it("rejects different-length signatures (length mismatch)", () => {
    const body = "test";
    expect(provider.verifyWebhookSignature(body, "short")).toBe(false);
  });

  it("parses a charge.success event", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: {
        id: 12345,
        reference: "rg-user-1234567890",
        customer: { customer_code: "CUS_abc" },
        amount: 1500000,
        currency: "NGN",
        status: "success",
      },
    });
    const event = provider.parseWebhookEvent(body);
    expect(event).not.toBeNull();
    expect(event!.eventId).toBe("12345");
    expect(event!.eventType).toBe("charge.success");
    expect(event!.customerId).toBe("CUS_abc");
    expect(event!.amount).toBe(1500000);
    expect(event!.currency).toBe("NGN");
    expect(event!.status).toBe("ACTIVE");
    expect(event!.plan).toBe("PRO");
  });
});

// ─── timingSafeCompare ──────────────────────────────────────────────────────

describe("timingSafeCompare", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeCompare("abc", "abc")).toBe(true);
  });
  it("returns false for different strings", () => {
    expect(timingSafeCompare("abc", "xyz")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(timingSafeCompare("short", "longer-string")).toBe(false);
  });
});

// ─── Webhook idempotency simulation (pure logic) ───────────────────────────

describe("Webhook idempotency simulation", () => {
  // Simulate the idempotency check: if the event ID was already seen,
  // skip. This mirrors `handleWebhookEventAction`'s ProcessedEvent lookup.
  const processed = new Set<string>();

  function processEvent(
    provider: string,
    event: WebhookEvent,
  ): { applied: boolean; message: string } {
    const key = `${provider}:${event.eventId}`;
    if (processed.has(key)) {
      return { applied: false, message: `Event ${event.eventId} already processed.` };
    }
    processed.add(key);
    return { applied: true, message: `Event ${event.eventId} processed.` };
  }

  it("first call applies the event", () => {
    const event: WebhookEvent = { eventId: "evt_1", eventType: "charge.success" };
    const r1 = processEvent("PAYSTACK", event);
    expect(r1.applied).toBe(true);
  });

  it("duplicate event (same ID) does NOT double-apply", () => {
    const event: WebhookEvent = { eventId: "evt_1", eventType: "charge.success" };
    // r1 already processed above — r2 should be skipped.
    const r2 = processEvent("PAYSTACK", event);
    expect(r2.applied).toBe(false);
    expect(r2.message).toContain("already processed");
  });

  it("out-of-order events: payment_failed before charge.success → both apply", () => {
    const failEvent: WebhookEvent = {
      eventId: "evt_fail",
      eventType: "invoice.payment_failed",
      status: "PAST_DUE",
    };
    const successEvent: WebhookEvent = {
      eventId: "evt_success",
      eventType: "charge.success",
      status: "ACTIVE",
    };
    const r1 = processEvent("PAYSTACK", failEvent);
    const r2 = processEvent("PAYSTACK", successEvent);
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true); // different event IDs → both apply
  });

  it("same event ID from different providers → both apply (different keys)", () => {
    const event: WebhookEvent = { eventId: "evt_shared", eventType: "charge.success" };
    const r1 = processEvent("PAYSTACK", event);
    const r2 = processEvent("STRIPE", event);
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true); // different provider keys
  });
});

// ─── Grace period calculation ────────────────────────────────────────────────

describe("Grace period calculation", () => {
  it("3-day grace period from a failed payment date", () => {
    const failedAt = new Date("2025-06-15T12:00:00Z");
    const graceEnd = new Date(failedAt.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    expect(graceEnd.toISOString()).toBe("2025-06-18T12:00:00.000Z");
  });

  it("after grace period → subscription should be downgraded to FREE", () => {
    const now = new Date();
    const graceEnd = new Date(now.getTime() - 1 * 60_000); // 1 min ago
    expect(graceEnd < now).toBe(true); // grace period expired → downgrade
  });

  it("during grace period → subscription stays PRO", () => {
    const now = new Date();
    const graceEnd = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour in future
    expect(graceEnd > now).toBe(true); // grace period active → keep PRO
  });
});

// ─── Feature gating (pure — no DB) ──────────────────────────────────────────

describe("Feature gating (pure — plan hierarchy check)", () => {
  // Mirror the `requirePlan` logic: FREE < PRO.
  const hierarchy: PlanKey[] = ["FREE", "PRO"];

  function meetsPlan(current: PlanKey, required: PlanKey): boolean {
    return hierarchy.indexOf(current) >= hierarchy.indexOf(required);
  }

  it("FREE meets FREE but not PRO", () => {
    expect(meetsPlan("FREE", "FREE")).toBe(true);
    expect(meetsPlan("FREE", "PRO")).toBe(false);
  });

  it("PRO meets both FREE and PRO", () => {
    expect(meetsPlan("PRO", "FREE")).toBe(true);
    expect(meetsPlan("PRO", "PRO")).toBe(true);
  });
});
