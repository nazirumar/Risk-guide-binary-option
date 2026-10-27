import Link from "next/link";
import { Wallet, Plus, Archive } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/trader/EmptyState";
import { AccountCard } from "@/components/accounts/AccountCard";
import { CreateAccountDialog } from "@/components/accounts/CreateAccountDialog";
import Decimal from "decimal.js";

/**
 * /app/accounts — list cards with name, broker, DEMO/REAL badge, balance,
 * today P/L. Includes Create dialog + filter toggle for archived accounts.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ showArchived?: string }>;
}) {
  const { userId, baseCurrency } = await requireUser();
  const sp = await searchParams;
  const showArchived = sp.showArchived === "1";

  const accounts = await db.tradingAccount.findMany({
    where: {
      userId,
      ...(showArchived ? {} : { isArchived: false }),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      broker: true,
      currency: true,
      type: true,
      startingBalance: true,
      currentBalance: true,
      isArchived: true,
      createdAt: true,
    },
  });

  // Today P/L per account
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const accountIds = accounts.map((a) => a.id);
  const tradesToday = accountIds.length
    ? await db.trade.findMany({
        where: {
          userId,
          tradingAccountId: { in: accountIds },
          result: { in: ["WIN", "LOSS", "TIE"] },
          openedAt: { gte: startOfToday },
        },
        select: { tradingAccountId: true, profitLoss: true },
      })
    : [];
  const plByAccount = new Map<string, Decimal>();
  for (const t of tradesToday) {
    const cur = plByAccount.get(t.tradingAccountId) ?? new Decimal(0);
    plByAccount.set(t.tradingAccountId, cur.plus(new Decimal(t.profitLoss.toString())));
  }

  const archivedCount = await db.tradingAccount.count({
    where: { userId, isArchived: true },
  });

  // Phase 18: balance-check accuracy per account over the trailing 30 days.
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const accuracyRows = accountIds.length
    ? await db.balanceCheck.findMany({
        where: {
          userId,
          tradingAccountId: { in: accountIds },
          checkedAt: { gte: since30 },
        },
        select: { tradingAccountId: true, resolution: true, checkedAt: true },
      })
    : [];
  const accuracyByAccount = new Map<string, { total: number; matched: number }>();
  for (const r of accuracyRows) {
    const cur = accuracyByAccount.get(r.tradingAccountId) ?? { total: 0, matched: 0 };
    cur.total += 1;
    if (r.resolution === "MATCHED") cur.matched += 1;
    accuracyByAccount.set(r.tradingAccountId, cur);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trading Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} active account{accounts.length === 1 ? "" : "s"} · {baseCurrency} base
            currency
          </p>
        </div>
        <div className="flex items-center gap-2">
          {archivedCount > 0 && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/app/accounts${showArchived ? "" : "?showArchived=1"}`}>
                <Archive className="size-4 mr-2" aria-hidden="true" />
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </Link>
            </Button>
          )}
          <CreateAccountDialog>
            <Button size="sm">
              <Plus className="size-4 mr-2" aria-hidden="true" />
              New account
            </Button>
          </CreateAccountDialog>
        </div>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={showArchived ? "No archived accounts" : "No trading accounts yet"}
          description={
            showArchived
              ? "Archived accounts will appear here. Restore one to bring it back."
              : "Add your first broker account — DEMO or REAL — to start tracking trades, deposits, withdrawals, and balances."
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((a) => {
            const todayPL = plByAccount.get(a.id) ?? new Decimal(0);
            const acc = accuracyByAccount.get(a.id) ?? { total: 0, matched: 0 };
            const accuracy =
              acc.total === 0
                ? null
                : { percent: Math.round((acc.matched / acc.total) * 100), total: acc.total };
            return (
              <AccountCard
                key={a.id}
                account={{
                  id: a.id,
                  name: a.name,
                  broker: a.broker,
                  currency: a.currency,
                  type: a.type,
                  currentBalance: new Decimal(a.currentBalance.toString()),
                  todayPL,
                  isArchived: a.isArchived,
                  createdAt: a.createdAt,
                  accuracy,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
