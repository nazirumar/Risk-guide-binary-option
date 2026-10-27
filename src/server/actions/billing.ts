"use server";

/**
 * Phase 24 — Billing server actions.
 *
 * Covers: checkout, billing overview, cancel, resume, webhook handling,
 * manual override, plan limits check.
 */
import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { getBillingProvider, type WebhookEvent } from "@/lib/billing/provider";
import { PLAN_CONFIGS, GRACE_PERIOD_DAYS, type PlanKey } from "@/lib/billing/plans";
import { PlanUpgradeRequiredError } from "@/server/lib/require-plan";

export type BillingResult = { ok: boolean; message: string; fieldErrors?: Record<string, string> };

// ─── Ensure a FREE subscription exists ──────────────────────────────────────

/** Called on login/onboarding to ensure the user has a Subscription row. */
export async function ensureSubscriptionAction(): Promise<void> {
  const { userId } = await requireUser();
  const existing = await db.subscription.findUnique({ where: { userId } });
  if (!existing) {
    await db.subscription.create({
      data: { userId, plan: "FREE", status: "ACTIVE" },
    });
  }
}

// ─── Create checkout ────────────────────────────────────────────────────────

export async function createCheckoutAction(): Promise<BillingResult & { checkoutUrl?: string }> {
  const { userId, email } = await requireUser();
  const provider = getBillingProvider();
  const currency = provider.name === "PAYSTACK" ? "NGN" : "USD";
  const amount =
    provider.name === "PAYSTACK"
      ? PLAN_CONFIGS.PRO.monthlyPriceNGN * 100 // kobo
      : PLAN_CONFIGS.PRO.monthlyPriceUSD * 100; // cents

  try {
    const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/app/billing`;
    const result = await provider.initializeCheckout({
      userId,
      userEmail: email,
      plan: "PRO",
      amount,
      currency,
      callbackUrl,
    });
    return { ok: true, message: "Checkout initialized.", checkoutUrl: result.checkoutUrl };
  } catch (e) {
    return { ok: false, message: `Checkout failed: ${e instanceof Error ? e.message : "unknown"}` };
  }
}

// ─── Billing overview ────────────────────────────────────────────────────────

export type BillingOverview = {
  plan: PlanKey;
  status: string;
  provider: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  gracePeriodEndsAt: string | null;
  monthlyPrice: number;
  currency: string;
  payments: {
    id: string;
    amount: string;
    currency: string;
    status: string;
    invoiceUrl: string | null;
    createdAt: Date;
  }[];
};

export async function getBillingOverviewAction(): Promise<
  BillingResult & { overview?: BillingOverview }
> {
  const { userId } = await requireUser();
  await ensureSubscriptionAction();
  const [sub, payments] = await Promise.all([
    db.subscription.findUniqueOrThrow({ where: { userId } }),
    db.payment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        invoiceUrl: true,
        createdAt: true,
      },
    }),
  ]);
  const plan = sub.plan as PlanKey;
  const config = PLAN_CONFIGS[plan];
  const currency = sub.paymentProvider === "STRIPE" ? "USD" : "NGN";
  const monthlyPrice = currency === "USD" ? config.monthlyPriceUSD : config.monthlyPriceNGN;
  return {
    ok: true,
    message: "Billing overview.",
    overview: {
      plan,
      status: sub.status,
      provider: sub.paymentProvider,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      gracePeriodEndsAt: sub.gracePeriodEndsAt?.toISOString() ?? null,
      monthlyPrice,
      currency,
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount.toString(),
        currency: p.currency,
        status: p.status,
        invoiceUrl: p.invoiceUrl,
        createdAt: p.createdAt,
      })),
    },
  };
}

// ─── Cancel subscription ─────────────────────────────────────────────────────

export async function cancelSubscriptionAction(): Promise<BillingResult> {
  const { userId } = await requireUser();
  const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
  if (sub.plan === "FREE") {
    return { ok: false, message: "You're on the Free plan — nothing to cancel." };
  }
  await db.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: true },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "SUBSCRIPTION_CANCELLED",
      entity: "Subscription",
      entityId: sub.id,
      meta: {},
    },
  });
  revalidatePath("/app/billing");
  return { ok: true, message: "Subscription cancelled — you keep access until the period ends." };
}

// ─── Resume subscription ────────────────────────────────────────────────────

export async function resumeSubscriptionAction(): Promise<BillingResult> {
  const { userId } = await requireUser();
  const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
  if (!sub.cancelAtPeriodEnd) {
    return { ok: false, message: "Subscription isn't cancelled — nothing to resume." };
  }
  await db.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: false, status: "ACTIVE" },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "SUBSCRIPTION_RESUMED",
      entity: "Subscription",
      entityId: sub.id,
      meta: {},
    },
  });
  revalidatePath("/app/billing");
  return { ok: true, message: "Subscription resumed." };
}

// ─── Handle webhook (idempotent) ────────────────────────────────────────────

/**
 * Process a webhook event. Idempotent — if the event ID was already
 * processed, returns early. This is the core of the duplicate-event
 * protection (spec acceptance: "duplicate webhooks don't double-apply").
 *
 * System-level — no requireUser (called by the webhook route with a
 * parsed event).
 */
export async function handleWebhookEventAction(
  provider: "PAYSTACK" | "STRIPE",
  event: WebhookEvent,
): Promise<BillingResult> {
  // Idempotency check — if this event was already processed, return.
  const existing = await db.processedEvent.findUnique({
    where: { provider_eventId: { provider, eventId: event.eventId } },
  });
  if (existing) {
    return { ok: true, message: `Event ${event.eventId} already processed.` };
  }

  // Find the user by providerCustomerId or subscriptionId.
  // For Paystack: we match by providerCustomerId. For test mode, the
  // ConsoleBillingProvider's webhook events may carry a userId directly.
  let sub = await db.subscription.findFirst({
    where: {
      OR: [
        { providerCustomerId: event.customerId ?? undefined },
        { providerSubscriptionId: event.subscriptionId ?? undefined },
      ],
    },
  });

  // If we can't find by provider IDs, try to find by a custom field in the
  // event (for test/dev where we pass userId directly in the event metadata).
  if (!sub && (event as WebhookEvent & { userId?: string }).userId) {
    sub = await db.subscription.findUnique({
      where: { userId: (event as WebhookEvent & { userId?: string }).userId! },
    });
  }

  if (!sub) {
    // Still record the processed event so we don't retry.
    await db.processedEvent.create({
      data: { provider, eventId: event.eventId, eventType: event.eventType },
    });
    return { ok: false, message: `No subscription found for event ${event.eventId}.` };
  }

  // Apply the event based on the event type.
  const updateData: Record<string, unknown> = {};
  const now = new Date();

  switch (event.eventType) {
    case "charge.success":
    case "subscription.create":
    case "invoice.payment_succeeded":
      updateData.plan = "PRO";
      updateData.status = "ACTIVE";
      updateData.cancelAtPeriodEnd = false;
      updateData.gracePeriodEndsAt = null;
      if (event.currentPeriodEnd) updateData.currentPeriodEnd = event.currentPeriodEnd;
      if (event.customerId) updateData.providerCustomerId = event.customerId;
      if (event.subscriptionId) updateData.providerSubscriptionId = event.subscriptionId;
      // Record the payment.
      if (event.amount != null) {
        await db.payment.create({
          data: {
            userId: sub.userId,
            amount: new Decimal(event.amount).div(100).toDecimalPlaces(2), // kobo/cents → major units
            currency: event.currency ?? "NGN",
            provider,
            providerPaymentId: event.paymentId,
            status: "SUCCESS",
            invoiceUrl: event.invoiceUrl,
          },
        });
      }
      break;

    case "subscription.disable":
    case "customer.subscription.deleted":
      updateData.status = "CANCELLED";
      updateData.plan = "FREE";
      break;

    case "invoice.payment_failed":
    case "charge.failed":
      updateData.status = "PAST_DUE";
      updateData.gracePeriodEndsAt = new Date(
        now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );
      break;

    default:
      // Unknown event type — record as processed, don't change subscription.
      break;
  }

  if (Object.keys(updateData).length > 0) {
    await db.subscription.update({
      where: { userId: sub.userId },
      data: updateData,
    });
  }

  // Record the processed event (idempotency).
  await db.processedEvent.create({
    data: { provider, eventId: event.eventId, eventType: event.eventType },
  });

  // Audit log.
  await db.auditLog.create({
    data: {
      userId: sub.userId,
      action: "WEBHOOK_PROCESSED",
      entity: "Subscription",
      entityId: sub.id,
      meta: JSON.parse(
        JSON.stringify({
          provider,
          eventId: event.eventId,
          eventType: event.eventType,
          ...updateData,
        }),
      ),
    },
  });

  return { ok: true, message: `Event ${event.eventId} processed: ${event.eventType}.` };
}

// ─── Manual override (admin-safe) ───────────────────────────────────────────

/**
 * Admin-safe manual override for support. Changes a user's plan directly.
 * Requires ADMIN_OVERRIDE_KEY env var matching the provided key.
 */
export async function manualOverrideAction(input: {
  userId: string;
  plan: PlanKey;
  overrideKey: string;
}): Promise<BillingResult> {
  if (input.overrideKey !== process.env.ADMIN_OVERRIDE_KEY) {
    return { ok: false, message: "Invalid override key." };
  }
  await db.subscription.update({
    where: { userId: input.userId },
    data: { plan: input.plan, status: "ACTIVE", cancelAtPeriodEnd: false, gracePeriodEndsAt: null },
  });
  await db.auditLog.create({
    data: {
      userId: input.userId,
      action: "SUBSCRIPTION_MANUAL_OVERRIDE",
      entity: "Subscription",
      entityId: input.userId,
      meta: { plan: input.plan },
    },
  });
  return { ok: true, message: `Plan set to ${input.plan}.` };
}

// ─── Grace period check (cron-friendly) ─────────────────────────────────────

/**
 * Check all PAST_DUE subscriptions — if the grace period has expired,
 * downgrade to FREE + EXPIRED. Called by the daily cron.
 */
export async function expireGracePeriodsAction(): Promise<
  BillingResult & { expiredCount?: number }
> {
  const now = new Date();
  const pastDueSubs = await db.subscription.findMany({
    where: { status: "PAST_DUE", gracePeriodEndsAt: { lt: now } },
  });
  let expired = 0;
  for (const sub of pastDueSubs) {
    await db.subscription.update({
      where: { userId: sub.userId },
      data: { plan: "FREE", status: "EXPIRED", gracePeriodEndsAt: null },
    });
    await db.auditLog.create({
      data: {
        userId: sub.userId,
        action: "SUBSCRIPTION_EXPIRED",
        entity: "Subscription",
        entityId: sub.id,
        meta: {},
      },
    });
    expired++;
  }
  return { ok: true, message: `Expired ${expired} past-due subscriptions.`, expiredCount: expired };
}
