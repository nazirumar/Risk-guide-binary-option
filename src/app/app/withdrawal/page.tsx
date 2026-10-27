import Link from "next/link";
import { PiggyBank, TrendingUp, Calendar, Trash2 } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import {
  getActiveAccountId,
  getActiveAccount,
  listUserAccounts,
} from "@/server/actions/active-account";
import { getWithdrawalStatusAction, listWithdrawalRulesAction } from "@/server/actions/withdrawals";
import { formatMoney, formatDate } from "@/lib/format";
import Decimal from "decimal.js";
import { StatCard } from "@/components/trader/StatCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { MarkWithdrawnDialog } from "@/components/withdrawal/MarkWithdrawnDialog";
import { WithdrawalRuleForm } from "@/components/withdrawal/WithdrawalRuleForm";
import { DeleteRuleButton } from "@/components/withdrawal/DeleteRuleButton";

/**
 * /app/withdrawal — Phase 19 Profit-Taking page.
 *
 * Server Component. Layout:
 *   - Stat grid: profit since baseline, recommended amount, banked profit,
 *     at-risk balance.
 *   - Active account selector (or fallback list of accounts).
 *   - Active rule card + edit form.
 *   - "Mark as withdrawn" dialog.
 *   - Withdrawal history table + totals (banked vs deposited).
 *
 * Accepts `?accountId=…` to scope to a specific account; defaults to the
 * active account.
 */
export default async function WithdrawalPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const { userId, baseCurrency } = await requireUser();
  const sp = await searchParams;
  const activeAccount = await getActiveAccount();
  const allAccounts = await listUserAccounts();

  // Resolve the account to show: explicit ?accountId=…, else active account.
  const targetAccountId = sp.accountId ?? activeAccount?.id ?? null;
  if (!targetAccountId) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Withdrawal & Profit-Taking</h1>
        <EmptyState
          icon={PiggyBank}
          title="No trading account yet"
          description="Add your first broker account to start tracking profit and withdrawals."
          actionLabel="Add account"
          actionHref="/app/accounts"
        />
      </div>
    );
  }

  // Verify the target account belongs to the user (rule #3).
  const account = await db.tradingAccount.findFirst({
    where: { id: targetAccountId, userId },
    select: {
      id: true,
      name: true,
      broker: true,
      currency: true,
      startingBalance: true,
      currentBalance: true,
    },
  });
  if (!account) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Withdrawal & Profit-Taking</h1>
        <EmptyState
          icon={PiggyBank}
          title="Account not found"
          description="This account doesn't exist or doesn't belong to you."
        />
      </div>
    );
  }

  // Pull the status + rules + withdrawal history in parallel.
  const [status, rulesResult, withdrawals, totals] = await Promise.all([
    getWithdrawalStatusAction(targetAccountId),
    listWithdrawalRulesAction({ tradingAccountId: targetAccountId }),
    db.transaction.findMany({
      where: { tradingAccountId: targetAccountId, type: "WITHDRAWAL" },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: { id: true, amount: true, note: true, occurredAt: true },
    }),
    db.transaction.groupBy({
      by: ["type"],
      where: { tradingAccountId: targetAccountId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
      _sum: { amount: true },
    }),
  ]);

  const depositedSum = totals.find((t) => t.type === "DEPOSIT")?._sum.amount ?? new Decimal(0);
  const withdrawnSum = totals.find((t) => t.type === "WITHDRAWAL")?._sum.amount ?? new Decimal(0);
  const banked = new Decimal(withdrawnSum.toString()).minus(new Decimal(depositedSum.toString()));

  const profitSinceBaseline = status.profitSinceBaseline
    ? new Decimal(status.profitSinceBaseline)
    : new Decimal(0);
  const recommendedAmount = status.recommendedAmount
    ? new Decimal(status.recommendedAmount)
    : new Decimal(0);
  const atRisk = new Decimal(account.currentBalance.toString());
  const isDue = !!status.isDue;
  const hasRule = !!status.rule;
  const activeRule = status.rule;
  const rules = rulesResult.rules ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Withdrawal & Profit-Taking</h1>
          <p className="text-sm text-muted-foreground">
            {account.name} ({account.broker}) · {account.currency}
            {hasRule && isDue && (
              <span className="ml-2 text-warning font-medium">· Withdrawal due</span>
            )}
          </p>
        </div>
        {recommendedAmount.gt(0) && (
          <MarkWithdrawnDialog
            tradingAccountId={account.id}
            accountName={account.name}
            currency={account.currency}
            currentBalance={account.currentBalance.toString()}
            recommendedAmount={recommendedAmount.toString()}
            ruleId={activeRule?.id}
          />
        )}
      </div>

      {/* Account selector (only show if user has multiple accounts) */}
      {allAccounts.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Account:</span>
          {allAccounts.map((a) => (
            <Link
              key={a.id}
              href={`/app/withdrawal?accountId=${a.id}`}
              className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs ${
                a.id === targetAccountId
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {a.name}
            </Link>
          ))}
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Profit since baseline"
          value={formatMoney(profitSinceBaseline, account.currency, { signed: true })}
          delta={status.lastWithdrawalBalance ? `since last withdrawal` : undefined}
          trend={profitSinceBaseline.gte(0) ? "up" : "down"}
          icon={TrendingUp}
        />
        <StatCard
          label="Recommended withdrawal"
          value={formatMoney(recommendedAmount, account.currency)}
          delta={hasRule ? `${activeRule!.type.replace(/_/g, " ").toLowerCase()}` : "No rule set"}
          trend={recommendedAmount.gt(0) ? "up" : "neutral"}
          icon={PiggyBank}
        />
        <StatCard
          label="Banked profit"
          value={formatMoney(banked, account.currency, { signed: true })}
          delta={`${formatMoney(withdrawnSum, account.currency)} withdrawn`}
          trend={banked.gte(0) ? "up" : "down"}
          icon={PiggyBank}
        />
        <StatCard
          label="At risk"
          value={formatMoney(atRisk, account.currency)}
          delta="still in broker"
          icon={TrendingUp}
        />
      </div>

      {/* Rule summary + edit form */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Active rule</h2>
          {hasRule ? (
            <>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium">
                    {activeRule!.type.replace(/_/g, " ").toLowerCase()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Value</span>
                  <span className="font-medium tabular-nums">{activeRule!.value}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Frequency</span>
                  <span className="font-medium">{activeRule!.frequency.toLowerCase()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Baseline</span>
                  <span className="font-medium">
                    {activeRule!.baseline.replace(/_/g, " ").toLowerCase()}
                  </span>
                </div>
                {status.highWaterMark != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">High-water mark</span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(status.highWaterMark, account.currency)}
                    </span>
                  </div>
                )}
                {status.lastWithdrawalBalance != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last withdrawal balance</span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(status.lastWithdrawalBalance, account.currency)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last triggered</span>
                  <span className="font-medium">
                    {activeRule!.lastTriggeredAt
                      ? formatDate(activeRule!.lastTriggeredAt, { withTime: true })
                      : "Never"}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active withdrawal rule for this account. Create one below to schedule reminders and
              a recommended amount.
            </p>
          )}
        </div>

        {/* Edit/Create form (only render if there's exactly one active rule, or none) */}
        <WithdrawalRuleForm
          tradingAccountId={account.id}
          existing={
            hasRule
              ? {
                  id: activeRule!.id,
                  type: activeRule!.type,
                  value: activeRule!.value,
                  frequency: activeRule!.frequency,
                  baseline: activeRule!.baseline,
                  isActive: activeRule!.isActive,
                }
              : undefined
          }
        />
      </div>

      {/* All rules for this account (incl. inactive) */}
      {rules.length > 1 && (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">All rules on this account ({rules.length})</h2>
          </div>
          <ul className="divide-y divide-border">
            {rules.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
                data-testid={`rule-row-${r.id}`}
              >
                <div className="text-sm">
                  <div className="font-medium">
                    {r.type.replace(/_/g, " ").toLowerCase()} = {r.value}{" "}
                    <span className="text-muted-foreground">· {r.frequency.toLowerCase()}</span>{" "}
                    <span className="text-muted-foreground">
                      · {r.baseline.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.isActive ? "Active" : "Paused"} · created {formatDate(r.createdAt)}
                  </div>
                </div>
                <DeleteRuleButton ruleId={r.id} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Withdrawal history */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Withdrawal history</h2>
          <div className="text-xs text-muted-foreground">
            <Calendar className="size-3 inline mr-1" aria-hidden="true" />
            {withdrawals.length} withdrawal{withdrawals.length === 1 ? "" : "s"} ·{" "}
            <span className="text-profit">
              {formatMoney(withdrawnSum, account.currency)} banked
            </span>
          </div>
        </div>
        {withdrawals.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={PiggyBank}
              title="No withdrawals yet"
              description="When you mark a withdrawal, it appears here. Banking profit regularly is the core discipline metric."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="withdrawal-history-table">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {withdrawals.map((w) => {
                  const amount = new Decimal(w.amount.toString());
                  return (
                    <tr key={w.id} data-testid="withdrawal-history-row">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDate(w.occurredAt, { withTime: true })}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-loss">
                        −{formatMoney(amount, account.currency)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground max-w-md truncate">
                        {w.note ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/30">
                <tr>
                  <td className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">
                    Total banked
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-profit">
                    {formatMoney(withdrawnSum, account.currency)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    Deposited: {formatMoney(depositedSum, account.currency)} · Banked profit:{" "}
                    {banked.gte(0) ? "+" : "−"}
                    {formatMoney(banked.abs(), account.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
