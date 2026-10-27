import Link from "next/link";
import { Wallet, MoreVertical, Archive, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyText } from "@/components/trader/MoneyText";
import { cn } from "@/lib/utils";
import { formatMoney, formatRelativeTime } from "@/lib/format";
import Decimal from "decimal.js";
import { ArchiveAccountButton } from "./ArchiveAccountButton";
import { RestoreAccountButton } from "./RestoreAccountButton";
import type { AccountType } from "@prisma/client";

type AccountCardData = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: AccountType;
  currentBalance: Decimal;
  todayPL: Decimal;
  isArchived: boolean;
  createdAt: Date;
  /** Phase 18: trailing-30-day broker-balance accuracy. null = no checks yet. */
  accuracy?: { percent: number; total: number } | null;
};

/**
 * AccountCard — list view of a single TradingAccount. Shows:
 *   - broker + name + DEMO/REAL badge
 *   - current balance (formatted by currency)
 *   - today's P/L with sign coloring
 *   - 30-day balance-sync accuracy badge (Phase 18) when checks exist
 *   - footer: "Added {date}" + archive/restore action
 */
export function AccountCard({ account }: { account: AccountCardData }) {
  return (
    <Card className={cn("p-4 flex flex-col gap-3", account.isArchived && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/app/accounts/${account.id}`}
          className="flex items-start gap-2 min-w-0 hover:opacity-80"
        >
          <div className="size-8 rounded-md bg-muted flex items-center justify-center shrink-0">
            <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{account.name}</div>
            <div className="text-xs text-muted-foreground truncate">{account.broker}</div>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px]",
              account.type === "REAL"
                ? "border-warning text-warning"
                : "border-muted-foreground/30 text-muted-foreground",
            )}
          >
            {account.type}
          </Badge>
          {account.isArchived ? (
            <RestoreAccountButton accountId={account.id} accountName={account.name} />
          ) : (
            <ArchiveAccountButton accountId={account.id} accountName={account.name} />
          )}
        </div>
      </div>

      <Link href={`/app/accounts/${account.id}`} className="block">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Balance</div>
          <div className="text-2xl font-bold tabular-nums">
            {formatMoney(account.currentBalance, account.currency)}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Today P/L</span>
          <MoneyText amount={account.todayPL} currency={account.currency} signed />
        </div>
        {account.accuracy && (
          <div
            className="mt-3 flex items-center justify-between"
            data-testid={`account-accuracy-${account.id}`}
          >
            <span className="text-xs text-muted-foreground">Balance accuracy (30d)</span>
            <span
              className={cn(
                "text-xs font-medium tabular-nums",
                account.accuracy.percent >= 80
                  ? "text-profit"
                  : account.accuracy.percent >= 50
                    ? "text-warning"
                    : "text-loss",
              )}
            >
              {account.accuracy.percent}% ({account.accuracy.total} check
              {account.accuracy.total === 1 ? "" : "s"})
            </span>
          </div>
        )}
        <div className="mt-3 text-xs text-muted-foreground">
          {account.isArchived ? "Archived" : "Added"} {formatRelativeTime(account.createdAt)}
        </div>
      </Link>
    </Card>
  );
}
