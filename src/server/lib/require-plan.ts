/**
 * Phase 24 — Feature gating helper.
 *
 * `requirePlan(plan)` is called at the top of server actions that gate
 * behind a plan. It reads the user's current subscription from the DB
 * (via requireUser → userId → Subscription lookup) and throws a
 * `PlanUpgradeRequiredError` if the user's plan doesn't meet the
 * required plan.
 *
 * The error is caught by the calling server action (which typically
 * returns an `{ ok: false, message: "Upgrade to PRO to access X" }` shape
 * so the UI can render an upgrade prompt).
 *
 * Per spec: "Existing users keep read access to their data after a
 * downgrade (never delete data because of a plan change)." So the gate
 * only blocks NEW writes — read access is always allowed.
 */
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { PLAN_CONFIGS, type PlanKey } from "@/lib/billing/plans";

export class PlanUpgradeRequiredError extends Error {
  constructor(
    public readonly requiredPlan: PlanKey,
    public readonly currentPlan: PlanKey,
    public readonly feature: string,
  ) {
    super(
      `This feature requires the ${PLAN_CONFIGS[requiredPlan].label} plan. You're on the ${PLAN_CONFIGS[currentPlan].label} plan.`,
    );
    this.name = "PlanUpgradeRequiredError";
  }
}

/**
 * Resolve the user's current plan from their Subscription row.
 * Defaults to FREE when no subscription exists (shouldn't happen —
 * the onboarding flow creates a FREE subscription — but be defensive).
 */
export async function getPlanForUser(userId: string): Promise<PlanKey> {
  const sub = await db.subscription.findUnique({
    where: { userId },
    select: { plan: true, status: true, gracePeriodEndsAt: true },
  });
  if (!sub) return "FREE";
  // PAST_DUE subscriptions still have PRO access during the grace period.
  // EXPIRED subscriptions are downgraded to FREE (the cron sets this).
  if (sub.status === "EXPIRED") return "FREE";
  return sub.plan as PlanKey;
}

/**
 * Check whether the user's plan includes a specific feature.
 */
export async function hasFeatureForUser(
  userId: string,
  feature: import("@/lib/billing/plans").PlanFeature,
): Promise<boolean> {
  const plan = await getPlanForUser(userId);
  return PLAN_CONFIGS[plan].features.includes(feature);
}

/**
 * Server-action guard: throw PlanUpgradeRequiredError if the user's plan
 * is below the required plan. The calling action catches this + returns
 * an upgrade-prompt shape.
 *
 * Plan hierarchy: FREE < PRO. A `requirePlan("PRO")` call blocks FREE
 * users; a `requirePlan("FREE")` call never blocks (everyone has at least
 * FREE).
 *
 * Per spec: read access is always allowed — only NEW writes are gated.
 * The caller decides when to call this (typically only on create/upgrade
 * actions, not on reads).
 */
export async function requirePlan(
  requiredPlan: PlanKey,
  opts: { feature?: string } = {},
): Promise<{ userId: string; plan: PlanKey }> {
  const { userId } = await requireUser();
  const currentPlan = await getPlanForUser(userId);

  const hierarchy: PlanKey[] = ["FREE", "PRO"];
  const currentIdx = hierarchy.indexOf(currentPlan);
  const requiredIdx = hierarchy.indexOf(requiredPlan);

  if (currentIdx < requiredIdx) {
    throw new PlanUpgradeRequiredError(requiredPlan, currentPlan, opts.feature ?? "this feature");
  }
  return { userId, plan: currentPlan };
}
