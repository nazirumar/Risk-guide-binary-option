"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { MoneyText } from "@/components/trader/MoneyText";
import { Button } from "@/components/ui/button";
import { formatMoney, formatDate } from "@/lib/format";
import type { TradeRow } from "./TradesTable";
import { ExternalLink, X, Tag, FileText } from "lucide-react";
import { CloseTradeButtons } from "./CloseTradeButtons";

/**
 * TradeDetailDrawer — slide-out panel showing the full trade record:
 * screenshot, notes, tags, all metadata. Opened via the eye-icon button
 * in the trades table.
 */
export function TradeDetailDrawer({ trade, onClose }: { trade: TradeRow; onClose: () => void }) {
  const isOpen = Boolean(trade);
  return (
    <Sheet open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="font-mono">{trade.asset}</span>
            <Badge
              variant="outline"
              className={
                trade.direction === "CALL" ? "border-profit text-profit" : "border-loss text-loss"
              }
            >
              {trade.direction}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {trade.accountName} · Opened {formatDate(trade.openedAt, { withTime: true })}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* P/L */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground uppercase">Stake</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatMoney(trade.stake, trade.accountCurrency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase">Payout</div>
              <div className="text-lg font-semibold tabular-nums">
                {(Number(trade.payoutPercent) * 100).toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase">Result</div>
              <div className="text-lg font-semibold">
                {trade.result}
                {trade.closedAt && (
                  <span className="block text-xs text-muted-foreground font-normal">
                    {formatDate(trade.closedAt, { withTime: true })}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase">P/L</div>
              <div className="text-lg font-semibold">
                {trade.result === "OPEN" ? (
                  <span className="text-warning">pending</span>
                ) : (
                  <MoneyText amount={trade.profitLoss} currency={trade.accountCurrency} signed />
                )}
              </div>
            </div>
          </div>

          {/* Balance after */}
          {trade.balanceAfter && (
            <div className="rounded-md bg-muted/40 p-2 text-xs">
              Balance after:{" "}
              <span className="font-medium tabular-nums">
                {formatMoney(trade.balanceAfter, trade.accountCurrency)}
              </span>
            </div>
          )}

          {/* Screenshot */}
          {trade.screenshotUrl && (
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground mb-1">
                Screenshot
              </div>
              <a
                href={trade.screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="block rounded-md overflow-hidden border border-border hover:opacity-90"
              >
                {}
                <img
                  src={trade.screenshotUrl}
                  alt={`Screenshot of ${trade.asset} ${trade.direction}`}
                  className="w-full h-auto"
                />
              </a>
              <a
                href={trade.screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3" aria-hidden="true" />
                Open in new tab
              </a>
            </div>
          )}

          {/* Notes */}
          {trade.notes && (
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <FileText className="size-3" aria-hidden="true" />
                Setup notes
              </div>
              <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/30 p-2">
                {trade.notes}
              </p>
            </div>
          )}

          {/* Tags */}
          {trade.tags.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Tag className="size-3" aria-hidden="true" />
                Tags
              </div>
              <div className="flex flex-wrap gap-1">
                {trade.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <dl className="text-xs space-y-1 border-t border-border pt-3">
            {trade.strategyName && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Strategy</dt>
                <dd className="font-medium">{trade.strategyName}</dd>
              </div>
            )}
            {trade.timeframe && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Timeframe</dt>
                <dd className="font-medium">{trade.timeframe}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Expiry</dt>
              <dd className="font-medium">{trade.expiryMinutes}m</dd>
            </div>
            {trade.emotion && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Emotion</dt>
                <dd className="font-medium">
                  {trade.emotion.charAt(0) + trade.emotion.slice(1).toLowerCase()}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Followed plan</dt>
              <dd className="font-medium">{trade.followedPlan ? "Yes" : "No"}</dd>
            </div>
          </dl>

          {/* Quick-close for OPEN trades */}
          {trade.result === "OPEN" && (
            <div className="border-t border-border pt-4">
              <div className="text-xs font-medium uppercase text-muted-foreground mb-2">
                Quick close
              </div>
              <CloseTradeButtons tradeId={trade.id} asset={trade.asset} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
