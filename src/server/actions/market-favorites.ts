"use server";

/**
 * Phase 28 — Market favorite (star) server actions.
 *
 * (PROJECT_RULES.md rule #3: every query is scoped by userId from the session —
 * the actions never accept a userId from the client. rule #4: input is validated
 * with Zod on the server.)
 *
 * Favorites live server-side (a `MarketFavorite` row), NOT localStorage, because
 * the worker reads them to decide who gets a "favorite pair flipped to
 * GOOD/AVOID" alert.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";

const ToggleSchema = z.object({ instrumentId: z.string().min(1).max(64) });

/** Toggle a pair as favorite for the current user. Returns the new state. */
export async function toggleFavoriteAction(input: {
  instrumentId: string;
}): Promise<{ favorited: boolean }> {
  const parsed = ToggleSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid instrument");
  const { instrumentId } = parsed.data;

  const user = await requireUser();

  const existing = await db.marketFavorite.findUnique({
    where: { userId_instrumentId: { userId: user.userId, instrumentId } },
    select: { id: true },
  });

  if (existing) {
    await db.marketFavorite.delete({ where: { id: existing.id } });
  } else {
    await db.marketFavorite.create({ data: { userId: user.userId, instrumentId } });
  }

  revalidatePath("/app/market");
  return { favorited: !existing };
}

/** Fetch the current user's favorite instrument ids. */
export async function getFavoritesAction(): Promise<string[]> {
  const user = await requireUser();
  const rows = await db.marketFavorite.findMany({
    where: { userId: user.userId },
    select: { instrumentId: true },
  });
  return rows.map((r) => r.instrumentId);
}
