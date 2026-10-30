import { Suspense } from "react";
import { Plus } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getNextStakeSuggestion } from "@/lib/staking";
import { db } from "@/lib/db";
import { listStrategiesWithStatsAction } from "@/server/actions/strategies";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddTradeForm } from "@/components/trades/AddTradeForm";
import { AddTradeDialog } from "@/components/trades/AddTradeDialog";
import { TradesTable } from "@/components/trades/TradesTable";
import { PayoutCalculator } from "@/components/trades/PayoutCalculator";
import { TradeSetupChecklist } from "@/components/trades/TradeSetupChecklist";
import { RiskPositionSizer } from "@/components/trades/RiskPositionSizer";
import { ExpirySuggestion } from "@/components/trades/ExpirySuggestion";
import { WinRateNeeded } from "@/components/trades/WinRateNeeded";
import { RiskOfRuin } from "@/components/trades/RiskOfRuin";
import { KellyCalculator } from "@/components/trades/KellyCalculator";

export default async function TradesPage() {
  const { userId } = await requireUser();
  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();
  // Phase 20: fetch strategies with their live reliability verdicts so the
  // Add Trade form can show a "Likely losing" warning when the user picks
  // a strategy with that verdict.
  const strategiesResult = await listStrategiesWithStatsAction();
  const strategies = (strategiesResult.strategies ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    verdict: s.reliability.verdict,
  }));

  // Phase 8: fetch the next-stake suggestion for the Add Trade form.
  const nextStakeSuggestion = activeAccount
    ? await getNextStakeSuggestion(userId, activeAccount.id)
    : null;

  // Trades table data — full user's history.
  const trades = await db.trade.findMany({
    where: { userId },
    orderBy: { openedAt: "desc" },
    take: 200,
    include: {
      tradingAccount: { select: { name: true, currency: true } },
      strategy: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Journal</h1>
          <p className="text-sm text-muted-foreground">
            {trades.length} trade{trades.length === 1 ? "" : "s"} recorded
            {activeAccount ? ` · Active account: ${activeAccount.name}` : ""}
          </p>
        </div>
        <AddTradeDialog
          accounts={accounts.map((a) => ({
            id: a.id,
            name: a.name,
            broker: a.broker,
            currency: a.currency,
            type: a.type as "DEMO" | "REAL",
            currentBalance: a.currentBalance.toString(),
          }))}
          activeAccountId={activeAccount?.id ?? null}
          strategies={strategies}
          nextStakeSuggestion={
            nextStakeSuggestion
              ? {
                  suggestedStake: nextStakeSuggestion.suggestedStake,
                  planName: nextStakeSuggestion.planName,
                  clamped: nextStakeSuggestion.clamped,
                }
              : null
          }
        >
          <Button size="sm">
            <Plus className="size-4 mr-2" aria-hidden="true" />
            Add trade
          </Button>
        </AddTradeDialog>
      </div>

      {/* Inline form for fast desktop entry (always visible above the table). */}
      <details className="rounded-lg border border-border bg-background" open>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          Quick add trade (mobile-friendly form)
        </summary>
        <div className="border-t border-border p-4">
          <AddTradeForm
            accounts={accounts.map((a) => ({
              id: a.id,
              name: a.name,
              broker: a.broker,
              currency: a.currency,
              type: a.type as "DEMO" | "REAL",
              currentBalance: a.currentBalance.toString(),
            }))}
            activeAccountId={activeAccount?.id ?? null}
            strategies={strategies}
            nextStakeSuggestion={
              nextStakeSuggestion
                ? {
                    suggestedStake: nextStakeSuggestion.suggestedStake,
                    planName: nextStakeSuggestion.planName,
                    clamped: nextStakeSuggestion.clamped,
                  }
                : null
            }
          />
        </div>
      </details>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TradeSetupChecklist />
        <PayoutCalculator />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <RiskPositionSizer />
        <ExpirySuggestion />
        <WinRateNeeded />
        <KellyCalculator />
        <RiskOfRuin />
      </div>

      {/* Trades table with filters, bulk delete, inline edit, detail drawer. */}
      <Suspense fallback={<Skeleton className="h-64" />}>
        <TradesTable
          trades={trades.map((t) => ({
            id: t.id,
            asset: t.asset,
            direction: t.direction,
            stake: t.stake.toString(),
            payoutPercent: t.payoutPercent.toString(),
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            result: t.result,
            profitLoss: t.profitLoss.toString(),
            balanceAfter: t.balanceAfter?.toString() ?? null,
            strategyName: t.strategy?.name ?? null,
            emotion: t.emotion ?? null,
            followedPlan: t.followedPlan,
            tags: t.tags as string[],
            notes: t.setupNotes ?? null,
            screenshotUrl: t.screenshotUrl ?? null,
            accountName: t.tradingAccount.name,
            accountCurrency: t.tradingAccount.currency,
            tradingAccountId: t.tradingAccountId,
            timeframe: t.timeframe ?? null,
            expiryMinutes: t.expiryMinutes,
          }))}
          strategies={strategies.map((s) => ({ id: s.id, name: s.name }))}
        />
      </Suspense>
    </div>
  );
}
