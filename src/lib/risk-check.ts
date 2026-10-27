/**
 * Risk-check types (kept here so they can be imported from both server-side
 * code that needs the implementation AND from any pure lib / UI component
 * that just needs the types — without dragging in the DB-coupled
 * implementation).
 *
 * The actual `evaluateRisk()` implementation lives in
 * `@/server/lib/risk-check` because it requires DB access (RiskProfile,
 * trades, lockouts). Server actions import the implementation; UI
 * components import the types.
 */
import type { TradeDirection } from "@prisma/client";

export type RiskSeverity = "OK" | "WARN" | "BLOCK";

export type RiskCheckResult = {
  allowed: boolean;
  severity: RiskSeverity;
  reasons: string[];
  context?: {
    dailyPL: string;
    weeklyPL: string;
    tradesToday: number;
    openTrades: number;
    currentLossStreak: number;
    balance: string;
    riskPerTradeLimit: string;
  };
};

export type RiskCheckInput = {
  userId: string;
  tradingAccountId: string;
  stake: number | string;
  direction?: TradeDirection;
};
