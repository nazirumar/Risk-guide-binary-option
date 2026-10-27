"use client";

/**
 * Phase 19 — "Mark as withdrawn" dialog.
 *
 * Pre-fills the recommended amount; the user can override before confirming.
 * On submit → markWithdrawnAction → atomically creates a WITHDRAWAL
 * transaction + recomputes balance + stamps the rule's lastTriggeredAt.
 *
 * Mirrors the Phase 4 ReconcileBalanceDialog + Phase 18 BalanceCheckDialog
 * patterns: Radix dialog with focus trap, mobile 90vh scroll, testids on
 * every interactive element.
 */
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { HandCoins } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/trader/FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { markWithdrawnAction } from "@/server/actions/withdrawals";
import { toast } from "@/hooks/use-toast";
import Decimal from "decimal.js";
import { formatMoney } from "@/lib/format";

type Props = {
  tradingAccountId: string;
  accountName: string;
  currency: string;
  currentBalance: string;
  recommendedAmount: string;
  ruleId?: string;
  triggerLabel?: string;
};

export function MarkWithdrawnDialog({
  tradingAccountId,
  accountName,
  currency,
  currentBalance,
  recommendedAmount,
  ruleId,
  triggerLabel = "Mark as withdrawn",
}: Props) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(new Decimal(recommendedAmount).toFixed(2));
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const amountRef = useRef<HTMLInputElement | null>(null);

  // When opening: pre-fill the recommended amount + autofocus. Use a
  // microtask to avoid calling setState during render. When closing: clear
  // the note (the amount is re-seeded on next open anyway).
  function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      setAmount(new Decimal(recommendedAmount).toFixed(2));
      // Defer focus to let Radix mount the input.
      setTimeout(() => amountRef.current?.focus(), 50);
    } else {
      setNote("");
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("tradingAccountId", tradingAccountId);
    fd.set("amount", amount);
    if (ruleId) fd.set("ruleId", ruleId);
    if (note) fd.set("note", note);
    startTransition(async () => {
      const res = await markWithdrawnAction(fd);
      if (!res.ok) {
        toast({ title: "Withdrawal failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Withdrawal recorded", description: res.message });
      setOpen(false);
      setNote("");
      router.refresh();
    });
  }

  const balance = new Decimal(currentBalance);
  const amountDecimal = amount ? new Decimal(amount) : new Decimal(0);
  const overBalance = amountDecimal.gt(balance);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          data-testid="mark-withdrawn-trigger"
        >
          <HandCoins className="size-4" aria-hidden="true" />
          {triggerLabel}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="mark-withdrawn-dialog">
        <DialogHeader>
          <DialogTitle>Withdraw profit from {accountName}</DialogTitle>
          <DialogDescription>
            Pre-filled with the recommended amount per your withdrawal rule. You can override it
            before confirming — a WITHDRAWAL transaction will be created atomically and the account
            balance recomputed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current balance:</span>
              <span className="font-medium tabular-nums">{formatMoney(balance, currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Recommended:</span>
              <span className="font-medium tabular-nums text-profit">
                {formatMoney(new Decimal(recommendedAmount), currency)}
              </span>
            </div>
          </div>

          <FormField
            label={`Amount to withdraw (${currency})`}
            htmlFor="withdrawal-amount"
            required
          >
            <Input
              id="withdrawal-amount"
              ref={amountRef}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={pending}
              placeholder="0.00"
              data-testid="withdrawal-amount-input"
            />
          </FormField>

          {overBalance && (
            <p className="text-xs text-loss" data-testid="withdrawal-over-balance">
              Amount exceeds the current balance — reduce it to record this withdrawal.
            </p>
          )}

          <FormField label="Note (optional)" htmlFor="withdrawal-note">
            <Textarea
              id="withdrawal-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={pending}
              placeholder="What's this withdrawal for?"
              rows={2}
              data-testid="withdrawal-note"
            />
          </FormField>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
              data-testid="withdrawal-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !amount || overBalance || amountDecimal.lte(0)}
              data-testid="withdrawal-confirm"
            >
              {pending ? "Recording…" : "Record withdrawal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
