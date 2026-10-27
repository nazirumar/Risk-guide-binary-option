import { notFound } from "next/navigation";
import { Wallet, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { MoneyText } from "@/components/trader/MoneyText";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { formatMoney, formatDate } from "@/lib/format";
import { CreateTransactionDialog } from "@/components/accounts/CreateTransactionDialog";
import { ReconcileBalanceDialog } from "@/components/accounts/ReconcileBalanceDialog";
import { BalanceCheckDialog } from "@/components/balance-sync/BalanceCheckDialog";
import { TransactionDeleteButton } from "@/components/accounts/TransactionDeleteButton";
import Decimal from "decimal.js";

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const { id } = await params;

  // PROJECT_RULES.md rule #3: every query is scoped by userId.
  const account = await db.tradingAccount.findFirst({
    where: { id, userId },
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
  if (!account) {
    notFound();
  }

  const [transactions, tradeCount, todayTrades, weekTrades] = await Promise.all([
    db.transaction.findMany({
      where: { tradingAccountId: account.id },
      orderBy: { occurredAt: "desc" },
      select: {
        id: true,
        type: true,
        amount: true,
        note: true,
        occurredAt: true,
      },
      take: 50,
    }),
    db.trade.count({
      where: { userId, tradingAccountId: account.id, result: { in: ["WIN", "LOSS", "TIE"] } },
    }),
    db.trade.findMany({
      where: {
        userId,
        tradingAccountId: account.id,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: startOfTodayUtc() },
      },
      select: { profitLoss: true },
    }),
    db.trade.findMany({
      where: {
        userId,
        tradingAccountId: account.id,
        result: { in: ["WIN", "LOSS", "TIE"] },
        openedAt: { gte: startOfWeekUtc() },
      },
      select: { profitLoss: true },
    }),
  ]);

  const todayPL = todayTrades.reduce(
    (sum, t) => sum.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );
  const weekPL = weekTrades.reduce(
    (sum, t) => sum.plus(new Decimal(t.profitLoss.toString())),
    new Decimal(0),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
            <Wallet className="size-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{account.name}</h1>
              <Badge
                variant="outline"
                className={
                  account.type === "REAL"
                    ? "border-warning text-warning"
                    : "border-muted-foreground/30 text-muted-foreground"
                }
              >
                {account.type}
              </Badge>
              {account.isArchived && <Badge variant="secondary">Archived</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {account.broker} · {account.currency} · Added {formatDate(account.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BalanceCheckDialog account={account} triggerLabel="Check balance" />
          <ReconcileBalanceDialog account={account} />
          <CreateTransactionDialog account={account}>
            <button className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">
              Add transaction
            </button>
          </CreateTransactionDialog>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Balance"
          value={formatMoney(account.currentBalance, account.currency)}
          icon={Wallet}
          hint={`Started at ${formatMoney(account.startingBalance, account.currency)}`}
        />
        <StatCard
          label="Today P/L"
          value={formatMoney(todayPL, account.currency, { signed: true })}
          trend={todayPL.gt(0) ? "up" : todayPL.lt(0) ? "down" : "neutral"}
          icon={todayPL.gte(0) ? ArrowUpRight : ArrowDownRight}
        />
        <StatCard
          label="Week P/L"
          value={formatMoney(weekPL, account.currency, { signed: true })}
          trend={weekPL.gt(0) ? "up" : weekPL.lt(0) ? "down" : "neutral"}
          icon={weekPL.gte(0) ? ArrowUpRight : ArrowDownRight}
        />
        <StatCard
          label="Trades"
          value={tradeCount}
          hint={`${todayTrades.length} today`}
          icon={Wallet}
        />
      </div>

      {/* Transaction history */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Transaction history</h2>
          <a
            href={`/api/accounts/${account.id}/export`}
            className="text-xs text-primary hover:underline"
            aria-label={`Download CSV of ${account.name}'s transactions`}
          >
            Export CSV ↓
          </a>
        </div>
        {transactions.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Wallet}
              title="No transactions yet"
              description="Record your first deposit, withdrawal, bonus, or adjustment to start the cash-flow ledger."
            />
          </div>
        ) : (
          <ul role="list" className="divide-y divide-border">
            {transactions.map((t) => {
              const amount = new Decimal(t.amount.toString());
              const signed = t.type === "WITHDRAWAL" ? amount.neg() : amount;
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                      <TxTypeIcon type={t.type} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{t.type}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {t.note || formatDate(t.occurredAt, { withTime: true })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <MoneyText amount={signed} currency={account.currency} signed />
                    <TransactionDeleteButton transactionId={t.id} tradingAccountId={account.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function TxTypeIcon({ type }: { type: "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT" }) {
  switch (type) {
    case "DEPOSIT":
    case "BONUS":
      return <ArrowDownRight className="size-4 text-profit" aria-hidden="true" />;
    case "WITHDRAWAL":
      return <ArrowUpRight className="size-4 text-loss" aria-hidden="true" />;
    case "ADJUSTMENT":
      return <Wallet className="size-4 text-warning" aria-hidden="true" />;
  }
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfWeekUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // Roll back to Sunday (UTC)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
