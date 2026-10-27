"use server";

/**
 * Phase 16 — Tilt detection server actions.
 *
 * detectTilt is a pure function in /src/lib/behavior/tilt.ts.
 * This module wires it into the trade-creation flow and persists TiltEvents.
 */
import { db } from "@/lib/db";
import { detectTilt } from "@/lib/behavior/tilt";
import type { TiltConfig, TiltResult, TiltTradeLike } from "@/lib/behavior/tilt";
import { requireUser } from "@/server/lib/require-user";
import Decimal from "decimal.js";
import type { Trade } from "@prisma/client";

export type TiltCheckResult = TiltResult & {
  tiltEventId: string | null;
  lockoutCreated: boolean;
};

/**
 * Internal: fetch recent trades + risk profile, run detectTilt, persist a
 * TiltEvent if the level is CAUTION or TILT.
 */
export async function checkTiltForAccount(
  userId: string,
  tradingAccountId: string,
  now: Date = new Date(),
): Promise<TiltCheckResult> {
  // Fetch recent trades for this account (last 30 days, most recent first).
  const recentTrades = await db.trade.findMany({
    where: {
      userId,
      tradingAccountId,
      result: { in: ["WIN", "LOSS", "TIE"] },
    },
    orderBy: { openedAt: "desc" },
    take: 100,
    select: {
      id: true,
      openedAt: true,
      stake: true,
      result: true,
      emotion: true,
      profitLoss: true,
    },
  });

  const tiltTrades: TiltTradeLike[] = recentTrades.map((t) => ({
    id: t.id,
    openedAt: t.openedAt,
    stake: t.stake.toString(),
    result: t.result,
    emotion: t.emotion,
    profitLoss: t.profitLoss.toString(),
  }));

  // Fetch risk profile for tilt config.
  const profile =
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId },
    })) ??
    (await db.riskProfile.findFirst({
      where: { userId, tradingAccountId: null },
      orderBy: { createdAt: "desc" },
    }));

  const config: TiltConfig = {
    tiltDetectionEnabled: profile?.tiltDetectionEnabled ?? true,
    tiltThreshold: profile?.tiltThreshold ? Number(profile.tiltThreshold.toString()) : 60,
    rapidRetradeMinutes: profile?.rapidRetradeMinutes ?? 2,
    stakeEscalationFactor: profile?.stakeEscalationFactor
      ? Number(profile.stakeEscalationFactor.toString())
      : 1.5,
    maxTradesPerHour: profile?.maxTradesPerHour ?? 6,
    tradingHours: null, // Trading hours from User — fetch separately if needed.
  };

  // Run detection.
  const result = detectTilt(tiltTrades, config, now);

  // Persist a TiltEvent if CAUTION or TILT (not for CALM).
  let tiltEventId: string | null = null;
  if (result.level !== "CALM") {
    const event = await db.tiltEvent.create({
      data: {
        userId,
        score: new Decimal(result.score),
        level: result.level,
        signals: result.signals as never,
      },
    });
    tiltEventId = event.id;

    // Update the user's tilt score + last tilt timestamp.
    await db.user.update({
      where: { id: userId },
      data: {
        tiltScore: new Decimal(result.score),
        lastTiltAt: now,
      },
    });
  }

  return {
    ...result,
    tiltEventId,
    lockoutCreated: false,
  };
}

/**
 * Create a manual 15-minute lockout from the tilt dialog.
 * Reuses the Phase 7 lockout infrastructure.
 */
export async function createTiltBreakAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const { userId } = await requireUser();

  // Check if there's already an active lockout.
  const active = await db.lockout.findFirst({
    where: {
      userId,
      overriddenAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (active) return { ok: false, message: "You already have an active lockout." };

  const lockout = await db.lockout.create({
    data: {
      userId,
      reason: "MANUAL",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "LOCKOUT_TILT_BREAK",
      entity: "Lockout",
      entityId: lockout.id,
      meta: { durationMinutes: 15, trigger: "TILT" },
    },
  });

  return { ok: true, message: "15-minute tilt break lockout created." };
}
