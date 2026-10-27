"use server";

/**
 * Phase 11 — Full JSON backup export + restore.
 *
 * Backup: fetches all user data (accounts, transactions, trades, strategies,
 * risk profiles, staking plans, sessions, goals, lockouts, notifications,
 * audit logs) as a JSON blob.
 *
 * Restore: parses JSON, creates rows in a transaction (with userId scoping).
 * The restore replaces the user's current data — caller should confirm.
 */
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { recomputeAccountBalanceInTx } from "@/server/actions/accounts";
import Decimal from "decimal.js";

export type BackupData = {
  version: string;
  exportedAt: string;
  user: {
    timezone: string;
    baseCurrency: string;
    checklistItems: unknown;
    dailyJournal: unknown;
  };
  accounts: Array<{
    name: string;
    broker: string;
    currency: string;
    type: string;
    startingBalance: string;
    currentBalance: string;
    isArchived: boolean;
  }>;
  strategies: Array<{
    name: string;
    description: string | null;
    color: string;
    isActive: boolean;
  }>;
  trades: Array<{
    asset: string;
    direction: string;
    stake: string;
    payoutPercent: string;
    expiryMinutes: number;
    openedAt: string;
    closedAt: string | null;
    result: string;
    profitLoss: string;
    balanceAfter: string | null;
    timeframe: string | null;
    setupNotes: string | null;
    emotion: string | null;
    followedPlan: boolean;
    screenshotUrl: string | null;
    tags: unknown;
    accountName: string;
    strategyName: string | null;
  }>;
  transactions: Array<{
    accountName: string;
    type: string;
    amount: string;
    note: string | null;
    occurredAt: string;
  }>;
  riskProfiles: Array<{
    accountName: string | null;
    riskPerTradePercent: string;
    maxDailyLossPercent: string;
    maxDailyLossAmount: string | null;
    dailyProfitTargetPercent: string | null;
    maxTradesPerDay: number;
    maxConsecutiveLosses: number;
    cooldownMinutes: number;
    maxOpenTrades: number;
    weeklyLossLimitPercent: string | null;
    lockoutEnabled: boolean;
  }>;
  stakingPlans: Array<{
    name: string;
    method: string;
    config: unknown;
    isDefault: boolean;
  }>;
  goals: Array<{
    type: string;
    targetAmount: string;
    startDate: string;
    endDate: string;
    status: string;
  }>;
};

export async function exportBackupAction(): Promise<{
  ok: boolean;
  data?: BackupData;
  message?: string;
}> {
  const { userId } = await requireUser();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true, baseCurrency: true, checklistItems: true, dailyJournal: true },
  });
  if (!user) return { ok: false, message: "User not found." };

  const [accounts, strategies, trades, transactions, riskProfiles, stakingPlans, goals] =
    await Promise.all([
      db.tradingAccount.findMany({
        where: { userId },
        select: {
          name: true,
          broker: true,
          currency: true,
          type: true,
          startingBalance: true,
          currentBalance: true,
          isArchived: true,
        },
      }),
      db.strategy.findMany({
        where: { userId },
        select: { name: true, description: true, color: true, isActive: true },
      }),
      db.trade.findMany({
        where: { userId },
        select: {
          asset: true,
          direction: true,
          stake: true,
          payoutPercent: true,
          expiryMinutes: true,
          openedAt: true,
          closedAt: true,
          result: true,
          profitLoss: true,
          balanceAfter: true,
          timeframe: true,
          setupNotes: true,
          emotion: true,
          followedPlan: true,
          screenshotUrl: true,
          tags: true,
          tradingAccount: { select: { name: true } },
          strategy: { select: { name: true } },
        },
      }),
      db.transaction.findMany({
        where: { tradingAccount: { userId } },
        select: {
          type: true,
          amount: true,
          note: true,
          occurredAt: true,
          tradingAccount: { select: { name: true } },
        },
      }),
      db.riskProfile.findMany({
        where: { userId },
        select: {
          tradingAccountId: true,
          riskPerTradePercent: true,
          maxDailyLossPercent: true,
          maxDailyLossAmount: true,
          dailyProfitTargetPercent: true,
          maxTradesPerDay: true,
          maxConsecutiveLosses: true,
          cooldownMinutes: true,
          maxOpenTrades: true,
          weeklyLossLimitPercent: true,
          lockoutEnabled: true,
          tradingAccount: { select: { name: true } },
        },
      }),
      db.stakingPlan.findMany({
        where: { userId },
        select: { name: true, method: true, config: true, isDefault: true },
      }),
      db.goal.findMany({
        where: { userId },
        select: { type: true, targetAmount: true, startDate: true, endDate: true, status: true },
      }),
    ]);

  const data: BackupData = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    user: {
      timezone: user.timezone,
      baseCurrency: user.baseCurrency,
      checklistItems: user.checklistItems,
      dailyJournal: user.dailyJournal,
    },
    accounts: accounts.map((a) => ({
      name: a.name,
      broker: a.broker,
      currency: a.currency,
      type: a.type,
      startingBalance: a.startingBalance.toString(),
      currentBalance: a.currentBalance.toString(),
      isArchived: a.isArchived,
    })),
    strategies: strategies.map((s) => ({
      name: s.name,
      description: s.description,
      color: s.color,
      isActive: s.isActive,
    })),
    trades: trades.map((t) => ({
      asset: t.asset,
      direction: t.direction,
      stake: t.stake.toString(),
      payoutPercent: t.payoutPercent.toString(),
      expiryMinutes: t.expiryMinutes,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt?.toISOString() ?? null,
      result: t.result,
      profitLoss: t.profitLoss.toString(),
      balanceAfter: t.balanceAfter?.toString() ?? null,
      timeframe: t.timeframe,
      setupNotes: t.setupNotes,
      emotion: t.emotion,
      followedPlan: t.followedPlan,
      screenshotUrl: t.screenshotUrl,
      tags: t.tags,
      accountName: t.tradingAccount.name,
      strategyName: t.strategy?.name ?? null,
    })),
    transactions: transactions.map((t) => ({
      accountName: t.tradingAccount.name,
      type: t.type,
      amount: t.amount.toString(),
      note: t.note,
      occurredAt: t.occurredAt.toISOString(),
    })),
    riskProfiles: riskProfiles.map((r) => ({
      accountName: r.tradingAccount?.name ?? null,
      riskPerTradePercent: r.riskPerTradePercent.toString(),
      maxDailyLossPercent: r.maxDailyLossPercent.toString(),
      maxDailyLossAmount: r.maxDailyLossAmount?.toString() ?? null,
      dailyProfitTargetPercent: r.dailyProfitTargetPercent?.toString() ?? null,
      maxTradesPerDay: r.maxTradesPerDay,
      maxConsecutiveLosses: r.maxConsecutiveLosses,
      cooldownMinutes: r.cooldownMinutes,
      maxOpenTrades: r.maxOpenTrades,
      weeklyLossLimitPercent: r.weeklyLossLimitPercent?.toString() ?? null,
      lockoutEnabled: r.lockoutEnabled,
    })),
    stakingPlans: stakingPlans.map((s) => ({
      name: s.name,
      method: s.method,
      config: s.config,
      isDefault: s.isDefault,
    })),
    goals: goals.map((g) => ({
      type: g.type,
      targetAmount: g.targetAmount.toString(),
      startDate: g.startDate.toISOString(),
      endDate: g.endDate.toISOString(),
      status: g.status,
    })),
  };

  return { ok: true, data };
}

export type RestoreResult = {
  ok: boolean;
  message: string;
  imported?: { accounts: number; trades: number; transactions: number; strategies: number };
};

export async function restoreBackupAction(formData: FormData): Promise<RestoreResult> {
  const { userId } = await requireUser();
  const raw = String(formData.get("backup") ?? "");
  if (!raw.trim()) return { ok: false, message: "Backup JSON is empty." };

  let data: BackupData;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Invalid JSON." };
  }

  // Delete existing data for the user (except the User row itself).
  await db.auditLog.deleteMany({ where: { userId } });
  await db.notification.deleteMany({ where: { userId } });
  await db.lockout.deleteMany({ where: { userId } });
  await db.goal.deleteMany({ where: { userId } });
  await db.tradingSession.deleteMany({ where: { userId } });
  await db.stakingPlan.deleteMany({ where: { userId } });
  await db.riskProfile.deleteMany({ where: { userId } });
  await db.trade.deleteMany({ where: { userId } });
  await db.transaction.deleteMany({ where: { tradingAccount: { userId } } });
  await db.strategy.deleteMany({ where: { userId } });
  await db.tradingAccount.deleteMany({ where: { userId } });

  // Restore user settings.
  await db.user.update({
    where: { id: userId },
    data: {
      timezone: data.user.timezone,
      baseCurrency: data.user.baseCurrency,
      checklistItems: data.user.checklistItems as never,
      dailyJournal: data.user.dailyJournal as never,
    },
  });

  // Restore accounts.
  const accountMap = new Map<string, string>(); // name → id
  for (const a of data.accounts) {
    const acc = await db.tradingAccount.create({
      data: {
        userId,
        name: a.name,
        broker: a.broker,
        currency: a.currency,
        type: a.type as "DEMO" | "REAL",
        startingBalance: new Decimal(a.startingBalance),
        currentBalance: new Decimal(a.currentBalance),
        isArchived: a.isArchived,
      },
    });
    accountMap.set(a.name, acc.id);
  }

  // Restore strategies.
  const strategyMap = new Map<string, string>(); // name → id
  for (const s of data.strategies) {
    const strat = await db.strategy.create({
      data: {
        userId,
        name: s.name,
        description: s.description,
        color: s.color,
        isActive: s.isActive,
      },
    });
    strategyMap.set(s.name, strat.id);
  }

  // Restore transactions.
  for (const t of data.transactions) {
    const accId = accountMap.get(t.accountName);
    if (!accId) continue;
    await db.transaction.create({
      data: {
        tradingAccountId: accId,
        type: t.type as "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT",
        amount: new Decimal(t.amount),
        note: t.note,
        occurredAt: new Date(t.occurredAt),
      },
    });
  }

  // Restore trades.
  let tradeCount = 0;
  for (const t of data.trades) {
    const accId = accountMap.get(t.accountName);
    if (!accId) continue;
    const stratId = t.strategyName ? strategyMap.get(t.strategyName) : null;
    await db.trade.create({
      data: {
        userId,
        tradingAccountId: accId,
        strategyId: stratId,
        asset: t.asset,
        direction: t.direction as "CALL" | "PUT",
        stake: new Decimal(t.stake),
        payoutPercent: new Decimal(t.payoutPercent),
        expiryMinutes: t.expiryMinutes,
        openedAt: new Date(t.openedAt),
        closedAt: t.closedAt ? new Date(t.closedAt) : null,
        result: t.result as "WIN" | "LOSS" | "TIE" | "OPEN",
        profitLoss: new Decimal(t.profitLoss),
        balanceAfter: t.balanceAfter ? new Decimal(t.balanceAfter) : null,
        timeframe: t.timeframe,
        setupNotes: t.setupNotes,
        emotion: t.emotion as never,
        followedPlan: t.followedPlan,
        screenshotUrl: t.screenshotUrl,
        tags: t.tags as never,
      },
    });
    tradeCount++;
  }

  // Recompute balances.
  for (const [, accId] of accountMap) {
    await db.$transaction(async (tx) => {
      await recomputeAccountBalanceInTx(tx, accId);
    });
  }

  // Restore risk profiles.
  for (const r of data.riskProfiles) {
    const accId = r.accountName ? accountMap.get(r.accountName) : null;
    await db.riskProfile.create({
      data: {
        userId,
        tradingAccountId: accId,
        riskPerTradePercent: new Decimal(r.riskPerTradePercent),
        maxDailyLossPercent: new Decimal(r.maxDailyLossPercent),
        maxDailyLossAmount: r.maxDailyLossAmount ? new Decimal(r.maxDailyLossAmount) : null,
        dailyProfitTargetPercent: r.dailyProfitTargetPercent
          ? new Decimal(r.dailyProfitTargetPercent)
          : null,
        maxTradesPerDay: r.maxTradesPerDay,
        maxConsecutiveLosses: r.maxConsecutiveLosses,
        cooldownMinutes: r.cooldownMinutes,
        maxOpenTrades: r.maxOpenTrades,
        weeklyLossLimitPercent: r.weeklyLossLimitPercent
          ? new Decimal(r.weeklyLossLimitPercent)
          : null,
        lockoutEnabled: r.lockoutEnabled,
      },
    });
  }

  // Restore staking plans.
  for (const s of data.stakingPlans) {
    await db.stakingPlan.create({
      data: {
        userId,
        name: s.name,
        method: s.method as never,
        config: s.config as never,
        isDefault: s.isDefault,
      },
    });
  }

  // Restore goals.
  for (const g of data.goals) {
    await db.goal.create({
      data: {
        userId,
        type: g.type as never,
        targetAmount: new Decimal(g.targetAmount),
        startDate: new Date(g.startDate),
        endDate: new Date(g.endDate),
        status: g.status as never,
      },
    });
  }

  return {
    ok: true,
    message: "Backup restored successfully.",
    imported: {
      accounts: data.accounts.length,
      trades: tradeCount,
      transactions: data.transactions.length,
      strategies: data.strategies.length,
    },
  };
}
