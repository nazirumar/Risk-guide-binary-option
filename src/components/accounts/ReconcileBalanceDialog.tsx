"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Scale } from "lucide-react";
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
import { previewReconcileAction, confirmReconcileAction } from "@/server/actions/transactions";
import { toast } from "@/hooks/use-toast";
import Decimal from "decimal.js";
import { formatMoney } from "@/lib/format";

type AccountLite = {
  id: string;
  name: string;
  currency: string;
  currentBalance: Decimal | string;
};

/**
 * ReconcileBalanceDialog — two-step flow:
 *   1. User enters the broker's real balance, hits "Preview"
 *      → server returns the difference + a message
 *   2. If difference ≠ 0, the "Create adjustment" button is enabled
 *      → server creates the ADJUSTMENT transaction atomically + recomputes balance
 */
export function ReconcileBalanceDialog({ account }: { account: AccountLite }) {
  const [open, setOpen] = useState(false);
  const [brokerBalance, setBrokerBalance] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{
    difference: Decimal;
    computed: Decimal;
    message: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const computed = new Decimal(account.currentBalance.toString());

  function onPreview(e: React.FormEvent) {
    e.preventDefault();
    setPreview(null);
    const fd = new FormData();
    fd.set("tradingAccountId", account.id);
    fd.set("brokerBalance", brokerBalance);
    startTransition(async () => {
      const res = await previewReconcileAction(fd);
      if (!res.ok) {
        toast({ title: "Preview failed", description: res.message, variant: "destructive" });
        return;
      }
      setPreview({
        difference: new Decimal(res.difference),
        computed: new Decimal(res.computedBalance),
        message: res.message,
      });
    });
  }

  function onConfirm() {
    const fd = new FormData();
    fd.set("tradingAccountId", account.id);
    fd.set("brokerBalance", brokerBalance);
    fd.set("note", note);
    startTransition(async () => {
      const res = await confirmReconcileAction(fd);
      if (!res.ok) {
        toast({ title: "Reconcile failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Reconciled", description: res.message });
      setOpen(false);
      setBrokerBalance("");
      setNote("");
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPreview(null);
          setBrokerBalance("");
          setNote("");
        }
      }}
    >
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent">
          <Scale className="size-4" aria-hidden="true" />
          Reconcile
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconcile balance</DialogTitle>
          <DialogDescription>
            Enter the balance your broker shows right now. If it differs from our books, an
            ADJUSTMENT transaction is created so they match.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onPreview} className="space-y-4">
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Our books:</span>
              <span className="font-medium tabular-nums">
                {formatMoney(computed, account.currency)}
              </span>
            </div>
          </div>

          <FormField
            label={`Broker balance (${account.currency})`}
            htmlFor="brokerBalance"
            required
          >
            <Input
              id="brokerBalance"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={brokerBalance}
              onChange={(e) => setBrokerBalance(e.target.value)}
              disabled={pending}
              placeholder="0.00"
            />
          </FormField>

          {preview && !preview.difference.isZero() && (
            <FormField label="Note (optional)" htmlFor="note">
              <Input
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={pending}
                placeholder="Reconciled against broker statement"
              />
            </FormField>
          )}

          {preview && (
            <div
              className={`rounded-md p-3 text-sm border ${
                preview.difference.isZero()
                  ? "bg-profit/10 border-profit/30 text-profit"
                  : "bg-warning/10 border-warning/30 text-warning"
              }`}
            >
              <div className="font-medium">{preview.message}</div>
              {!preview.difference.isZero() && (
                <div className="mt-1 text-xs">
                  Adjustment to be created:{" "}
                  <span className="font-mono tabular-nums">
                    {preview.difference.gt(0) ? "+" : "-"}
                    {preview.difference.abs().toFixed(2)} {account.currency}
                  </span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {preview && !preview.difference.isZero() ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setPreview(null)}
                  disabled={pending}
                >
                  Re-enter
                </Button>
                <Button type="button" onClick={onConfirm} disabled={pending}>
                  {pending ? "Recording…" : `Create adjustment`}
                </Button>
              </>
            ) : preview?.difference.isZero() ? (
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <Button type="submit" disabled={pending || !brokerBalance}>
                {pending ? "Computing…" : "Preview difference"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
