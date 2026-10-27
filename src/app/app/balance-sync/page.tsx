import Link from "next/link";
import { RefreshCw, Filter } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { listBalanceChecksAction } from "@/server/actions/balance-sync";
import { formatMoney, formatDate } from "@/lib/format";
import Decimal from "decimal.js";
import { BalanceCheckDialog } from "@/components/balance-sync/BalanceCheckDialog";
import { getActiveAccount } from "@/server/actions/active-account";
import { EmptyState } from "@/components/trader/EmptyState";

/**
 * /app/balance-sync — Phase 18 history page.
 *
 * Server Component. Filters via searchParams:
 *   ?accountId=…        — limit to one account
 *   ?resolution=MATCHED|ADJUSTED|IGNORED|PENDING  — limit by resolution
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  — date range
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId.
 */
export default async function BalanceSyncPage({
  searchParams,
}: {
  searchParams: Promise<{
    accountId?: string;
    resolution?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { userId, baseCurrency } = await requireUser();
  const sp = await searchParams;
  const activeAccount = await getActiveAccount();

  const resolution = sp.resolution as "MATCHED" | "ADJUSTED" | "IGNORED" | "PENDING" | undefined;

  const result = await listBalanceChecksAction({
    tradingAccountId: sp.accountId,
    resolution,
    fromIso: sp.from ? `${sp.from}T00:00:00.000Z` : undefined,
    toIso: sp.to ? `${sp.to}T23:59:59.999Z` : undefined,
  });

  // List of accounts the user has — for the account filter dropdown.
  const accounts = await db.tradingAccount.findMany({
    where: { userId, isArchived: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, currency: true, currentBalance: true },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Balance Sync</h1>
          <p className="text-sm text-muted-foreground">
            Track every broker balance check and how it was resolved.
          </p>
        </div>
        {activeAccount && (
          <BalanceCheckDialog
            account={{
              id: activeAccount.id,
              name: activeAccount.name,
              currency: activeAccount.currency,
              currentBalance: activeAccount.currentBalance,
            }}
            triggerLabel="New check"
          />
        )}
      </div>

      {/* Filters */}
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
        data-testid="balance-sync-filters"
      >
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Filter className="size-4" aria-hidden="true" />
          Filters
        </div>
        <div>
          <label htmlFor="filter-account" className="block text-xs text-muted-foreground mb-1">
            Account
          </label>
          <select
            id="filter-account"
            name="accountId"
            defaultValue={sp.accountId ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-resolution" className="block text-xs text-muted-foreground mb-1">
            Resolution
          </label>
          <select
            id="filter-resolution"
            name="resolution"
            defaultValue={sp.resolution ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All</option>
            <option value="MATCHED">Matched</option>
            <option value="ADJUSTED">Adjusted</option>
            <option value="IGNORED">Ignored</option>
            <option value="PENDING">Pending</option>
          </select>
        </div>
        <div>
          <label htmlFor="filter-from" className="block text-xs text-muted-foreground mb-1">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-to" className="block text-xs text-muted-foreground mb-1">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <button
          type="submit"
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          data-testid="balance-sync-apply-filters"
        >
          Apply
        </button>
        {(sp.accountId || sp.resolution || sp.from || sp.to) && (
          <Link
            href="/app/balance-sync"
            className="h-9 px-3 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            data-testid="balance-sync-clear-filters"
          >
            Clear
          </Link>
        )}
      </form>

      {/* History table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {result.totalCount ?? 0} check{(result.totalCount ?? 0) === 1 ? "" : "s"} found
          </h2>
        </div>
        {result.rows && result.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="balance-sync-table">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5 text-right">App balance</th>
                  <th className="px-4 py-2.5 text-right">Broker balance</th>
                  <th className="px-4 py-2.5 text-right">Difference</th>
                  <th className="px-4 py-2.5">Resolution</th>
                  <th className="px-4 py-2.5">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.rows.map((row) => {
                  const diff = new Decimal(row.difference);
                  return (
                    <tr key={row.id} data-testid="balance-sync-row">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDate(row.checkedAt, { withTime: true })}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/app/accounts/${row.tradingAccountId}`}
                          className="hover:underline"
                        >
                          {row.accountName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMoney(row.appBalance, baseCurrency)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMoney(row.brokerBalance, baseCurrency)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          diff.isZero() ? "" : diff.gt(0) ? "text-profit" : "text-loss"
                        }`}
                      >
                        {diff.isZero() ? "—" : `${diff.gt(0) ? "+" : "−"}${diff.abs().toFixed(2)}`}
                      </td>
                      <td className="px-4 py-3">
                        <ResolutionBadge resolution={row.resolution} />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground max-w-xs truncate">
                        {row.note ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4">
            <EmptyState
              icon={RefreshCw}
              title="No balance checks yet"
              description="Run your first check from the dashboard banner, the Accounts page, or the New check button above."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ResolutionBadge({
  resolution,
}: {
  resolution: "MATCHED" | "ADJUSTED" | "IGNORED" | null;
}) {
  if (resolution === null) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-warning/15 text-warning font-medium">
        PENDING
      </span>
    );
  }
  const styles: Record<string, string> = {
    MATCHED: "bg-profit/15 text-profit",
    ADJUSTED: "bg-warning/15 text-warning",
    IGNORED: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${styles[resolution]}`}
      data-testid={`resolution-${resolution.toLowerCase()}`}
    >
      {resolution}
    </span>
  );
}
