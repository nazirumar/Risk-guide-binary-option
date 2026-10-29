"use server";

/**
 * Phase 29 — Market-edge server actions (trade warnings + settings).
 *
 * (PROJECT_RULES.md rule #3: every user-scoped query is userId-bound; rule #4:
 * Zod on every input; rule #8: settings changes are audit-logged; rule #11:
 * wording is descriptive — a rating reports conditions, never outcomes.)
 *
 *   - `getMarketEdgeAction` — the Add Trade warning panel + the server's
 *     AVOID-dialog decision for one pair. Advisory only: it never blocks a
 *     save, it reports what the live condition IS.
 *   - `updateMarketWarningSettingsAction` — Settings card persistence.
 */
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { marketWarningSettingsSchema } from "@/lib/validation";
import {
  buildMarketWarningInfo,
  getMarketWarningSettings,
  type MarketWarningSettings,
} from "@/server/lib/trade-market";
import type { PrepareMarketInfo } from "@/server/actions/pre-trade-types";

export type MarketEdgeResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type GetMarketEdgeResult = MarketEdgeResult & {
  /** Live condition + personal record + avoidConfirmRequired (see types). */
  market?: PrepareMarketInfo;
  settings?: Pick<MarketWarningSettings, "warningsEnabled" | "ignoreAvoidOnDemo">;
};

/**
 * Current market state for the traded pair (Add Trade form). The trading
 * account resolves the DEMO carve-out server-side — the client never decides
 * whether the warning applies, it only renders what this returns.
 */
export async function getMarketEdgeAction(input: {
  asset: string;
  tradingAccountId?: string;
}): Promise<GetMarketEdgeResult> {
  const { userId } = await requireUser();

  const asset = String(input.asset ?? "").trim();
  if (!asset || asset.length > 50) {
    return { ok: true, message: "No asset selected.", market: { hasData: false } };
  }

  // Account lookup is userId-scoped (rule #3) — unknown id → assume REAL so
  // the AVOID dialog is never silently skipped.
  let accountType: "DEMO" | "REAL" = "REAL";
  if (input.tradingAccountId) {
    const account = await db.tradingAccount.findFirst({
      where: { id: input.tradingAccountId, userId },
      select: { type: true },
    });
    if (account) accountType = account.type === "DEMO" ? "DEMO" : "REAL";
  }

  try {
    const market = await buildMarketWarningInfo(userId, asset, accountType);
    const settings = await getMarketWarningSettings(userId);
    return {
      ok: true,
      message: market.hasData ? "Live market data available." : "No market data for this instrument.",
      market,
      settings: { warningsEnabled: settings.warningsEnabled, ignoreAvoidOnDemo: settings.ignoreAvoidOnDemo },
    };
  } catch (e) {
    // Advisory surface — degrade to "no data" instead of breaking the form.
    console.error("getMarketEdgeAction failed:", e);
    return {
      ok: true,
      message: "Market data unavailable right now.",
      market: { hasData: false, avoidConfirmRequired: false },
    };
  }
}

/** Persist the Phase 29 warning settings (Settings page card). */
export async function updateMarketWarningSettingsAction(
  formData: FormData,
): Promise<MarketEdgeResult> {
  const { userId } = await requireUser();

  const parsed = marketWarningSettingsSchema.safeParse({
    warningsEnabled: formData.get("warningsEnabled") === "true",
    ignoreAvoidOnDemo: formData.get("ignoreAvoidOnDemo") === "true",
    avoidOverrideWeight: Number(formData.get("avoidOverrideWeight") ?? 5),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Please fix the highlighted fields.", fieldErrors };
  }

  const d = parsed.data;
  await db.user.update({
    where: { id: userId },
    data: {
      marketWarningsEnabled: d.warningsEnabled,
      marketWarningsIgnoreAvoidDemo: d.ignoreAvoidOnDemo,
      avoidOverrideWeight: d.avoidOverrideWeight,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "MARKET_WARNING_SETTINGS_UPDATED",
      entity: "User",
      entityId: userId,
      meta: {
        warningsEnabled: d.warningsEnabled,
        ignoreAvoidOnDemo: d.ignoreAvoidOnDemo,
        avoidOverrideWeight: d.avoidOverrideWeight,
      },
    },
  });

  revalidatePath("/app/settings");
  revalidatePath("/app/trades");
  return {
    ok: true,
    message: `Market warnings saved: ${d.warningsEnabled ? "on" : "off"}, AVOID discipline weight ${d.avoidOverrideWeight}.`,
  };
}
