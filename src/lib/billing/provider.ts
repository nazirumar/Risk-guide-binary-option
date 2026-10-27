/**
 * Phase 24 — Payment provider interface (swappable: Paystack + Stripe).
 *
 * The interface is minimal so any provider can be swapped in. The DB
 * caching layer (Subscription + Payment models) is the source of truth;
 * the provider is only called for checkout initialization + webhook
 * verification.
 *
 * Production wiring:
 *   - `ConsoleBillingProvider`: dev/test fallback — returns a fake checkout
 *     URL + auto-confirms subscriptions. Use for local dev + CI.
 *   - `PaystackProvider`: NGN-first, card + bank transfer. Uses Paystack's
 *     Initialize Transaction + Verify Payment APIs. Requires
 *     PAYSTACK_SECRET_KEY.
 *   - `StripeProvider`: global, USD. Uses Stripe Checkout Sessions +
 *     Webhooks. Requires STRIPE_SECRET_KEY.
 */

import { createHmac, timingSafeEqual, createHash } from "node:crypto";

// ─── Timing-safe comparison helper ──────────────────────────────────────────

/**
 * Timing-safe string comparison. Hashes both strings to a fixed length
 * first (so length differences don't leak), then uses `timingSafeEqual`.
 * Returns false when either input is null/undefined/empty.
 */
export function timingSafeCompare(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type CheckoutResult = {
  /** URL the user should be redirected to for payment. */
  checkoutUrl: string;
  /** Provider reference for the checkout session. */
  reference: string;
};

export type WebhookEvent = {
  /** Unique event ID from the provider (for idempotency). */
  eventId: string;
  /** Event type (e.g. "charge.success", "subscription.create",
   *  "subscription.disable", "invoice.payment_failed"). */
  eventType: string;
  /** The provider's customer ID (e.g. Paystack customer code, Stripe
   *  customer ID). */
  customerId?: string;
  /** The provider's subscription ID. */
  subscriptionId?: string;
  /** The plan the user subscribed to (mapped from the provider's plan
   *  code). */
  plan?: "FREE" | "PRO";
  /** The new subscription status. */
  status?: "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";
  /** When the current billing period ends. */
  currentPeriodEnd?: Date;
  /** Payment amount in minor units (kobo for NGN, cents for USD). */
  amount?: number;
  /** Currency code ("NGN" or "USD"). */
  currency?: string;
  /** Invoice URL for the payment record. */
  invoiceUrl?: string;
  /** The provider's payment/transaction ID. */
  paymentId?: string;
};

// ─── Interface ───────────────────────────────────────────────────────────────

export interface BillingProvider {
  readonly name: "PAYSTACK" | "STRIPE";

  /**
   * Initialize a checkout session for a PRO subscription.
   * Returns a checkout URL the user should be redirected to.
   */
  initializeCheckout(input: {
    userId: string;
    userEmail: string;
    plan: "PRO";
    amount: number;
    currency: "NGN" | "USD";
    callbackUrl: string;
  }): Promise<CheckoutResult>;

  /**
   * Verify the webhook signature (timing-safe). Returns true iff the
   * signature matches the configured secret.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /**
   * Parse the raw webhook body into a normalized WebhookEvent.
   * Returns null when the event can't be parsed.
   */
  parseWebhookEvent(rawBody: string): WebhookEvent | null;
}

// ─── Console provider (dev/test fallback) ──────────────────────────────────

/**
 * Dev-only billing provider. Returns a fake checkout URL (just "#")
 * + auto-confirms everything. Webhook verification always passes (so
 * tests can send webhook events without a real signature). Webhook parsing
 * expects a JSON body with the shape { eventId, eventType, ... }.
 */
export class ConsoleBillingProvider implements BillingProvider {
  readonly name = "PAYSTACK" as const;

  async initializeCheckout(input: {
    userId: string;
    userEmail: string;
    plan: "PRO";
    amount: number;
    currency: "NGN" | "USD";
    callbackUrl: string;
  }): Promise<CheckoutResult> {
    const reference = `test-${input.userId}-${Date.now()}`;
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `\n────────── BILLING (dev console fallback) ──────────\n` +
          `User: ${input.userId}\nPlan: ${input.plan}\nReference: ${reference}\n` +
          `Redirect to: ${input.callbackUrl}\n` +
          `─────────────────────────────────────────────────────\n`,
      );
    }
    return {
      checkoutUrl: input.callbackUrl,
      reference,
    };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    return true; // dev/test — always pass
  }

  parseWebhookEvent(rawBody: string): WebhookEvent | null {
    try {
      const parsed = JSON.parse(rawBody) as WebhookEvent;
      if (!parsed.eventId || !parsed.eventType) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

// ─── Paystack provider ──────────────────────────────────────────────────────

/**
 * Paystack billing provider (NGN-first, card + bank transfer).
 * Uses the Initialize Transaction API for checkout + the Paystack signature
 * (HMAC-SHA512 of the raw body with PAYSTACK_SECRET_KEY) for webhook
 * verification.
 */
export class PaystackProvider implements BillingProvider {
  readonly name = "PAYSTACK" as const;
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async initializeCheckout(input: {
    userId: string;
    userEmail: string;
    plan: "PRO";
    amount: number;
    currency: "NGN" | "USD";
    callbackUrl: string;
  }): Promise<CheckoutResult> {
    const reference = `rg-${input.userId}-${Date.now()}`;
    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.userEmail,
        amount: input.amount, // in kobo
        currency: input.currency,
        reference,
        callback_url: input.callbackUrl,
        metadata: {
          userId: input.userId,
          plan: input.plan,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Paystack checkout failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      data?: { authorization_url?: string; reference?: string };
    };
    return {
      checkoutUrl: data.data?.authorization_url ?? input.callbackUrl,
      reference: data.data?.reference ?? reference,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha512", this.secretKey).update(rawBody).digest("hex");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  parseWebhookEvent(rawBody: string): WebhookEvent | null {
    try {
      const body = JSON.parse(rawBody) as {
        event?: string;
        data?: {
          id?: number;
          reference?: string;
          customer?: { customer_code?: string };
          amount?: number;
          currency?: string;
          status?: string;
        };
      };
      const eventType = body.event ?? "unknown";
      const data = body.data ?? {};
      // Map Paystack event types to our normalized shape.
      const statusMap: Record<string, "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED"> = {
        success: "ACTIVE",
        failed: "PAST_DUE",
        abandoned: "EXPIRED",
      };
      return {
        eventId: String(data.id ?? data.reference ?? ""),
        eventType,
        customerId: data.customer?.customer_code,
        paymentId: data.reference,
        amount: data.amount,
        currency: data.currency,
        status: statusMap[data.status ?? ""] ?? undefined,
        plan: "PRO", // Paystack doesn't carry the plan in the event — we infer from the subscription lookup
      };
    } catch {
      return null;
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

let _provider: BillingProvider | null = null;

/**
 * Resolve the configured billing provider:
 *   1. Test-registered provider via `setBillingProvider`.
 *   2. `PaystackProvider` when PAYSTACK_SECRET_KEY is set.
 *   3. `StripeProvider` when STRIPE_SECRET_KEY is set (TODO — not yet implemented).
 *   4. `ConsoleBillingProvider` (dev fallback).
 */
export function getBillingProvider(): BillingProvider {
  if (_provider) return _provider;
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (paystackKey && paystackKey.length > 0) {
    _provider = new PaystackProvider(paystackKey);
  } else if (stripeKey && stripeKey.length > 0) {
    // TODO Phase 24+: implement StripeProvider. For now, fall back to Console.
    _provider = new ConsoleBillingProvider();
  } else {
    _provider = new ConsoleBillingProvider();
  }
  return _provider;
}

/**
 * Test-only: register a custom provider.
 */
export function setBillingProvider(provider: BillingProvider | null): void {
  _provider = provider;
}
