"use server";

import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { checkRealisticGoal } from "@/lib/calc/compounding";
import { z } from "zod";

const createGoalSchema = z.object({
  type: z.enum(["DAILY", "WEEKLY", "MONTHLY", "BALANCE_TARGET"]),
  targetAmount: z.number().positive(),
  startDate: z.string(),
  endDate: z.string(),
});

export type GoalResult = { ok: boolean; message: string; fieldErrors?: Record<string, string> };

export async function createGoalAction(formData: FormData): Promise<GoalResult> {
  const { userId } = await requireUser();
  const parsed = createGoalSchema.safeParse({
    type: formData.get("type"),
    targetAmount: Number(formData.get("targetAmount")),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = i.path[0]?.toString();
      if (k && !fe[k]) fe[k] = i.message;
    }
    return { ok: false, message: "Fix the highlighted fields.", fieldErrors: fe };
  }

  const goal = await db.goal.create({
    data: {
      userId,
      type: parsed.data.type,
      targetAmount: new Decimal(parsed.data.targetAmount).toDecimalPlaces(2),
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "GOAL_CREATED",
      entity: "Goal",
      entityId: goal.id,
      meta: { type: parsed.data.type, target: parsed.data.targetAmount },
    },
  });

  revalidatePath("/app/goals");
  return { ok: true, message: "Goal created." };
}

export async function deleteGoalAction(formData: FormData): Promise<GoalResult> {
  const { userId } = await requireUser();
  const goalId = String(formData.get("goalId") ?? "");
  if (!goalId) return { ok: false, message: "Missing goal id." };
  await db.goal.deleteMany({ where: { id: goalId, userId } });
  revalidatePath("/app/goals");
  return { ok: true, message: "Goal deleted." };
}

export async function updateDailyJournalAction(formData: FormData): Promise<GoalResult> {
  const { userId } = await requireUser();
  const dateStr = String(formData.get("date") ?? "");
  const entry = String(formData.get("entry") ?? "");
  if (!dateStr) return { ok: false, message: "Date required." };

  const user = await db.user.findUnique({ where: { id: userId }, select: { dailyJournal: true } });
  const journal = (user?.dailyJournal as Record<string, string>) ?? {};
  if (entry.trim()) {
    journal[dateStr] = entry.trim();
  } else {
    delete journal[dateStr];
  }
  await db.user.update({ where: { id: userId }, data: { dailyJournal: journal as never } });
  revalidatePath("/app/goals");
  return { ok: true, message: "Journal saved." };
}

export async function updateChecklistAction(formData: FormData): Promise<GoalResult> {
  const { userId } = await requireUser();
  const items = formData.getAll("items").map(String).filter(Boolean);
  if (items.length === 0) return { ok: false, message: "Add at least one checklist item." };
  await db.user.update({ where: { id: userId }, data: { checklistItems: items as never } });
  revalidatePath("/app/goals");
  return { ok: true, message: "Checklist updated." };
}
