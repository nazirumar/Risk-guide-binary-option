"use server";

/**
 * Phase 8 — StakingPlan CRUD server actions.
 *
 * Saves plans with the per-method config (Zod-validated on save). The
 * default plan is the one shown in the Add Trade form's "next stake"
 * suggestion. Only one default per user; setting a new default unsets the
 * previous default.
 */
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { z } from "zod";

export type StakingPlanResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  planId?: string;
};

const configSchema = z.object({}).passthrough(); // The shape varies per method; UI validates.

const createPlanSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  method: z.enum([
    "FIXED_AMOUNT",
    "FIXED_PERCENT",
    "COMPOUNDING",
    "ANTI_MARTINGALE",
    "FIBONACCI",
    "MARTINGALE",
    "KELLY_FRACTION",
    "CUSTOM",
  ]),
  config: configSchema,
  isDefault: z.boolean().optional(),
});

export async function createStakingPlanAction(formData: FormData): Promise<StakingPlanResult> {
  const { userId } = await requireUser();
  const configRaw = formData.get("config");
  let configObj: unknown;
  try {
    configObj = typeof configRaw === "string" ? JSON.parse(configRaw) : configRaw;
  } catch {
    return { ok: false, message: "Invalid plan config (not valid JSON)." };
  }

  const parsed = createPlanSchema.safeParse({
    name: formData.get("name"),
    method: formData.get("method"),
    config: configObj,
    isDefault: formData.get("isDefault") === "true",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  // If isDefault, unset the previous default.
  if (parsed.data.isDefault) {
    await db.stakingPlan.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const plan = await db.stakingPlan.create({
    data: {
      userId,
      name: parsed.data.name,
      method: parsed.data.method,
      config: parsed.data.config as never,
      isDefault: parsed.data.isDefault ?? false,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "STAKING_PLAN_CREATED",
      entity: "StakingPlan",
      entityId: plan.id,
      meta: { name: plan.name, method: plan.method, isDefault: plan.isDefault },
    },
  });

  revalidatePath("/app/stake-calculator");
  return { ok: true, message: `Plan "${plan.name}" created.`, planId: plan.id };
}

export async function updateStakingPlanAction(formData: FormData): Promise<StakingPlanResult> {
  const { userId } = await requireUser();
  const planId = String(formData.get("planId") ?? "");
  if (!planId) return { ok: false, message: "Missing plan id." };

  const owned = await db.stakingPlan.findFirst({
    where: { id: planId, userId },
    select: { id: true },
  });
  if (!owned) return { ok: false, message: "Plan not found." };

  const configRaw = formData.get("config");
  let configObj: unknown;
  try {
    configObj = typeof configRaw === "string" ? JSON.parse(configRaw) : configRaw;
  } catch {
    return { ok: false, message: "Invalid plan config (not valid JSON)." };
  }

  const parsed = createPlanSchema.partial().safeParse({
    name: formData.get("name") || undefined,
    method: formData.get("method") || undefined,
    config: configObj,
    isDefault: formData.get("isDefault") === "true",
  });
  if (!parsed.success) {
    return { ok: false, message: "Please fix the highlighted fields." };
  }

  // If making default, unset the previous default.
  if (parsed.data.isDefault) {
    await db.stakingPlan.updateMany({
      where: { userId, isDefault: true, NOT: { id: planId } },
      data: { isDefault: false },
    });
  }

  await db.stakingPlan.update({
    where: { id: planId },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.method ? { method: parsed.data.method } : {}),
      ...(parsed.data.config ? { config: parsed.data.config as never } : {}),
      ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
    },
  });

  revalidatePath("/app/stake-calculator");
  return { ok: true, message: "Plan updated.", planId };
}

export async function deleteStakingPlanAction(formData: FormData): Promise<StakingPlanResult> {
  const { userId } = await requireUser();
  const planId = String(formData.get("planId") ?? "");
  if (!planId) return { ok: false, message: "Missing plan id." };

  // Use updateMany with userId scope so cross-user delete is a silent no-op.
  const result = await db.stakingPlan.deleteMany({
    where: { id: planId, userId },
  });
  if (result.count === 0) return { ok: false, message: "Plan not found." };

  revalidatePath("/app/stake-calculator");
  return { ok: true, message: "Plan deleted." };
}

export async function setDefaultStakingPlanAction(formData: FormData): Promise<StakingPlanResult> {
  const { userId } = await requireUser();
  const planId = String(formData.get("planId") ?? "");
  if (!planId) return { ok: false, message: "Missing plan id." };

  const owned = await db.stakingPlan.findFirst({
    where: { id: planId, userId },
    select: { id: true },
  });
  if (!owned) return { ok: false, message: "Plan not found." };

  // Unset previous default.
  await db.stakingPlan.updateMany({
    where: { userId, isDefault: true },
    data: { isDefault: false },
  });
  await db.stakingPlan.update({
    where: { id: planId },
    data: { isDefault: true },
  });

  revalidatePath("/app/stake-calculator");
  revalidatePath("/app/trades");
  return { ok: true, message: "Default plan set." };
}
