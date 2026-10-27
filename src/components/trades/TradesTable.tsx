"use client";

import * as React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Eye,
  Trash2,
  CheckCircle2,
  XCircle,
  CircleSlash,
  Clock,
} from "lucide-react";
import Decimal from "decimal.js";

import { DataTable } from "@/components/trader/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateRangePicker } from "@/components/trader/DateRangePicker";
import { MoneyText } from "@/components/trader/MoneyText";
import { ConfirmDialog } from "@/components/trader/ConfirmDialog";
import { TradeDetailDrawer } from "./TradeDetailDrawer";
import { CloseTradeButtons } from "./CloseTradeButtons";
import { TradeEditDialog } from "./TradeEditDialog";
import { deleteTradeAction, bulkDeleteTradesAction } from "@/server/actions/trades";
import { toast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { formatMoney, formatDate } from "@/lib/format";
import type { DateRange } from "react-day-picker";

export type TradeRow = {
  id: string;
  asset: string;
  direction: "CALL" | "PUT";
  stake: string;
  payoutPercent: string;
  openedAt: Date;
  closedAt: Date | null;
  result: "WIN" | "LOSS" | "TIE" | "OPEN";
  profitLoss: string;
  balanceAfter: string | null;
  strategyName: string | null;
  emotion: string | null;
  followedPlan: boolean;
  tags: string[];
  notes: string | null;
  screenshotUrl: string | null;
  accountName: string;
  accountCurrency: string;
  tradingAccountId: string;
  timeframe: string | null;
  expiryMinutes: number;
};

type FilterState = {
  dateRange: DateRange | undefined;
  asset: string;
  result: "" | "WIN" | "LOSS" | "TIE" | "OPEN";
  strategyId: string;
  emotion: string;
  followedPlan: "" | "yes" | "no";
  tag: string;
};

/**
 * TradesTable — Phase 5 spec: filters (date range, asset, result, strategy,
 * emotion, followedPlan, tags), sorting, pagination, bulk delete, inline
 * edit, trade detail drawer.
 *
 * Built on the Phase 3 DataTable. Most filters apply client-side to the
 * already-fetched trades (Phase 11 will move server-side filtering for big
 * datasets).
 */
export function TradesTable({
  trades,
  strategies,
}: {
  trades: TradeRow[];
  strategies: { id: string; name: string }[];
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [filters, setFilters] = React.useState<FilterState>({
    dateRange: undefined,
    asset: "",
    result: "",
    strategyId: "",
    emotion: "",
    followedPlan: "",
    tag: "",
  });
  const [drawerId, setDrawerId] = React.useState<string | null>(null);
  const [editId, setEditId] = React.useState<string | null>(null);
  const router = useRouter();

  // Apply filters.
  const filtered = React.useMemo(() => {
    return trades.filter((t) => {
      if (filters.dateRange?.from) {
        if (t.openedAt < filters.dateRange.from) return false;
      }
      if (filters.dateRange?.to) {
        const end = new Date(filters.dateRange.to);
        end.setUTCHours(23, 59, 59, 999);
        if (t.openedAt > end) return false;
      }
      if (filters.asset && !t.asset.toLowerCase().includes(filters.asset.toLowerCase()))
        return false;
      if (filters.result && t.result !== filters.result) return false;
      if (filters.strategyId) {
        // Match by strategy name (the table doesn't have strategyId, just name).
        const strategyName = strategies.find((s) => s.id === filters.strategyId)?.name;
        if (t.strategyName !== strategyName) return false;
      }
      if (filters.emotion && t.emotion !== filters.emotion) return false;
      if (filters.followedPlan === "yes" && !t.followedPlan) return false;
      if (filters.followedPlan === "no" && t.followedPlan) return false;
      if (filters.tag) {
        if (!t.tags.some((tg) => tg.toLowerCase().includes(filters.tag.toLowerCase())))
          return false;
      }
      return true;
    });
  }, [trades, filters, strategies]);

  // Build DataTable columns
  const columns: ColumnDef<TradeRow>[] = React.useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            className="size-4"
            checked={filtered.length > 0 && selected.size === filtered.length}
            onChange={(e) => {
              setSelected(e.target.checked ? new Set(filtered.map((t) => t.id)) : new Set());
            }}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="size-4"
            checked={selected.has(row.original.id)}
            onChange={(e) => {
              setSelected((s) => {
                const next = new Set(s);
                if (e.target.checked) next.add(row.original.id);
                else next.delete(row.original.id);
                return next;
              });
            }}
            aria-label={`Select ${row.original.asset}`}
          />
        ),
        enableSorting: false,
      },
      {
        accessorKey: "openedAt",
        header: "Date",
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setDrawerId(row.original.id)}
            className="text-left text-xs hover:underline"
            aria-label={`View trade details for ${row.original.asset}`}
          >
            <div>{format(row.original.openedAt, "MMM dd")}</div>
            <div className="text-muted-foreground">{format(row.original.openedAt, "HH:mm")}</div>
          </button>
        ),
      },
      {
        accessorKey: "asset",
        header: "Asset",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-mono text-xs font-medium">{row.original.asset}</span>
            <span className="text-[10px] text-muted-foreground">{row.original.accountName}</span>
          </div>
        ),
      },
      {
        accessorKey: "direction",
        header: "Dir",
        cell: ({ row }) => {
          const dir = row.original.direction;
          return (
            <span
              className={cn(
                "inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded",
                dir === "CALL" ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss",
              )}
            >
              {dir === "CALL" ? (
                <ArrowUpRight className="size-3" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="size-3" aria-hidden="true" />
              )}
              {dir}
            </span>
          );
        },
      },
      {
        accessorKey: "stake",
        header: "Stake",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums">
            {formatMoney(row.original.stake, row.original.accountCurrency)}
          </span>
        ),
      },
      {
        accessorKey: "result",
        header: "Result",
        cell: ({ row }) => <ResultBadge result={row.original.result} />,
      },
      {
        accessorKey: "profitLoss",
        header: "P/L",
        cell: ({ row }) => (
          <MoneyText
            amount={row.original.result === "OPEN" ? "0" : row.original.profitLoss}
            currency={row.original.accountCurrency}
            signed
          />
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            {row.original.result === "OPEN" && (
              <CloseTradeButtons tradeId={row.original.id} asset={row.original.asset} />
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setDrawerId(row.original.id)}
              aria-label={`View ${row.original.asset} trade details`}
            >
              <Eye className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setEditId(row.original.id)}
              aria-label={`Edit ${row.original.asset} trade`}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
            <ConfirmDialog
              destructive
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Delete ${row.original.asset} trade`}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              }
              title="Delete this trade?"
              description="The account balance + equity walk will be recomputed. This cannot be undone."
              confirmLabel="Delete"
              onConfirm={async () => {
                const fd = new FormData();
                fd.set("tradeId", row.original.id);
                const res = await deleteTradeAction(fd);
                if (res.ok) {
                  toast({ title: "Trade deleted", description: res.message });
                  router.refresh();
                } else {
                  toast({ title: "Failed", description: res.message, variant: "destructive" });
                }
              }}
            />
          </div>
        ),
        enableSorting: false,
      },
    ],
    [filtered, selected, router],
  );

  // Active filters count for the UI badge
  const activeFilterCount = Object.values(filters).filter((v) => {
    if (v === "" || v === undefined) return false;
    if (
      typeof v === "object" &&
      v !== undefined &&
      "from" in (v as DateRange) &&
      !(v as DateRange).from
    )
      return false;
    return true;
  }).length;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Filters:</span>
          {activeFilterCount > 0 && <Badge variant="secondary">{activeFilterCount} active</Badge>}
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              setFilters({
                dateRange: undefined,
                asset: "",
                result: "",
                strategyId: "",
                emotion: "",
                followedPlan: "",
                tag: "",
              })
            }
            disabled={activeFilterCount === 0}
          >
            Clear all
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <DateRangePicker
            value={filters.dateRange}
            onChange={(r) => setFilters((f) => ({ ...f, dateRange: r }))}
          />
          <Input
            placeholder="Asset filter"
            value={filters.asset}
            onChange={(e) => setFilters((f) => ({ ...f, asset: e.target.value }))}
            className="h-9"
          />
          <select
            value={filters.result}
            onChange={(e) =>
              setFilters((f) => ({ ...f, result: e.target.value as FilterState["result"] }))
            }
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All results</option>
            <option value="WIN">WIN</option>
            <option value="LOSS">LOSS</option>
            <option value="TIE">TIE</option>
            <option value="OPEN">OPEN</option>
          </select>
          <select
            value={filters.strategyId}
            onChange={(e) => setFilters((f) => ({ ...f, strategyId: e.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All strategies</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={filters.emotion}
            onChange={(e) => setFilters((f) => ({ ...f, emotion: e.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All emotions</option>
            {["CALM", "CONFIDENT", "FEARFUL", "GREEDY", "REVENGE", "TIRED", "BORED"].map((e) => (
              <option key={e} value={e}>
                {e.charAt(0) + e.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <select
            value={filters.followedPlan}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                followedPlan: e.target.value as FilterState["followedPlan"],
              }))
            }
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All trades</option>
            <option value="yes">Followed plan</option>
            <option value="no">Broke plan</option>
          </select>
          <Input
            placeholder="Tag contains…"
            value={filters.tag}
            onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))}
            className="h-9"
          />
        </div>
      </div>

      {/* Bulk delete toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
          <span className="text-sm text-warning">
            {selected.size} trade{selected.size === 1 ? "" : "s"} selected
          </span>
          <ConfirmDialog
            destructive
            trigger={
              <Button size="sm" variant="destructive">
                <Trash2 className="size-4 mr-2" aria-hidden="true" />
                Bulk delete
              </Button>
            }
            title={`Delete ${selected.size} trade${selected.size === 1 ? "" : "s"}?`}
            description="The account balance + equity walk will be recomputed for every affected account. This cannot be undone."
            confirmLabel="Delete all"
            onConfirm={async () => {
              const fd = new FormData();
              for (const id of Array.from(selected)) fd.append("tradeIds", id);
              const res = await bulkDeleteTradesAction(fd);
              if (res.ok) {
                toast({ title: "Deleted", description: res.message });
                setSelected(new Set());
                router.refresh();
              } else {
                toast({ title: "Failed", description: res.message, variant: "destructive" });
              }
            }}
          />
        </div>
      )}

      <DataTable
        columns={columns}
        data={filtered}
        pageSize={25}
        emptyTitle="No trades match these filters"
        emptyDescription="Try clearing some filters or adding your first trade."
        emptyIcon={Minus}
      />

      {/* Trade detail drawer */}
      {drawerId && (
        <TradeDetailDrawer
          trade={trades.find((t) => t.id === drawerId)!}
          onClose={() => setDrawerId(null)}
        />
      )}

      {/* Trade edit dialog */}
      {editId && (
        <TradeEditDialog
          trade={trades.find((t) => t.id === editId)!}
          strategies={strategies}
          onClose={() => setEditId(null)}
        />
      )}
    </div>
  );
}

function ResultBadge({ result }: { result: TradeRow["result"] }) {
  switch (result) {
    case "WIN":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-profit">
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
          WIN
        </span>
      );
    case "LOSS":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-loss">
          <XCircle className="size-3.5" aria-hidden="true" />
          LOSS
        </span>
      );
    case "TIE":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground">
          <CircleSlash className="size-3.5" aria-hidden="true" />
          TIE
        </span>
      );
    case "OPEN":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-warning animate-pulse">
          <Clock className="size-3.5" aria-hidden="true" />
          OPEN
        </span>
      );
  }
}

// Inline icon import to avoid extra lucide-react group at the top of the file
import { Pencil } from "lucide-react";
