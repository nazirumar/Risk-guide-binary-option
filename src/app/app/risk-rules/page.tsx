import { notFound } from "next/navigation";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getRiskProfileForAccount } from "@/server/actions/risk-rules";
import { db } from "@/lib/db";
import { RiskProfileForm } from "@/components/risk/RiskProfileForm";
import { ManualLockoutButton } from "@/components/risk/ManualLockoutButton";
import Decimal from "decimal.js";

export default async function RiskRulesPage() {
  const { userId } = await requireUser();
  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();

  // If no active account, prompt user to create one.
  if (!activeAccount) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Risk Rules</h1>
        <p className="text-sm text-muted-foreground">
          You need at least one trading account before you can configure risk rules. Add one from
          the Accounts page.
        </p>
      </div>
    );
  }

  // Fetch the existing risk profile for the active account (or fall back to global).
  const profile = await getRiskProfileForAccount(activeAccount.id);
  if (!profile) {
    // No profile yet — use Phase 2 onboarding defaults.
    return (
      <RiskProfileForm
        account={{
          id: activeAccount.id,
          name: activeAccount.name,
          currency: activeAccount.currency,
        }}
        defaults={{
          riskPerTradePercent: 2,
          maxDailyLossPercent: 6,
          maxDailyLossAmount: null,
          dailyProfitTargetPercent: null,
          maxTradesPerDay: 10,
          maxConsecutiveLosses: 3,
          cooldownMinutes: 15,
          maxOpenTrades: 3,
          weeklyLossLimitPercent: null,
          lockoutEnabled: true,
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Risk Rules</h1>
          <p className="text-sm text-muted-foreground">
            Discipline limits for <strong>{activeAccount.name}</strong> ({activeAccount.broker})
          </p>
        </div>
        <ManualLockoutButton />
      </div>

      <RiskProfileForm
        account={{
          id: activeAccount.id,
          name: activeAccount.name,
          currency: activeAccount.currency,
        }}
        defaults={{
          riskPerTradePercent: Number(
            new Decimal(profile.riskPerTradePercent.toString()).toString(),
          ),
          maxDailyLossPercent: Number(
            new Decimal(profile.maxDailyLossPercent.toString()).toString(),
          ),
          maxDailyLossAmount: profile.maxDailyLossAmount
            ? Number(profile.maxDailyLossAmount.toString())
            : null,
          dailyProfitTargetPercent: profile.dailyProfitTargetPercent
            ? Number(profile.dailyProfitTargetPercent.toString())
            : null,
          maxTradesPerDay: profile.maxTradesPerDay,
          maxConsecutiveLosses: profile.maxConsecutiveLosses,
          cooldownMinutes: profile.cooldownMinutes,
          maxOpenTrades: profile.maxOpenTrades,
          weeklyLossLimitPercent: profile.weeklyLossLimitPercent
            ? Number(profile.weeklyLossLimitPercent.toString())
            : null,
          lockoutEnabled: profile.lockoutEnabled,
        }}
      />
    </div>
  );
}
