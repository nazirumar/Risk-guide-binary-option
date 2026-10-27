"use client";

/**
 * Phase 18 — BalanceCheckDialog.
 *
 * Two-step flow mirroring the Phase 4 ReconcileBalanceDialog:
 *   1. Enter broker balance → submit → server reads app balance, computes
 *      difference, returns MATCHED or the difference + possible causes.
 *   2. If MATCHED → close. If mismatched → offer three paths:
 *        a. "Create adjustment" → resolveBalanceCheckAction(ADJUSTED)
 *           (atomically creates an ADJUSTMENT transaction + recomputes
 *           balance via the Phase 4 reconcile path).
 *        b. "Ignore with note" → resolveBalanceCheckAction(IGNORED).
 *        c. "Possible causes" panel — pure-calc `suggestCauses` output.
 *
 * The dialog is keyboard accessible (Enter submits, Esc cancels — Radix
 * handles focus trap) and mobile-friendly (90vh scroll, stacked buttons).
 * All interactive elements carry `data-testid` selectors for e2e.
 */
import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Scale, AlertTriangle, CheckCircle2, Wand2 } from "lucide-react";
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
import { createBalanceCheckAction, resolveBalanceCheckAction } from "@/server/actions/balance-sync";
import { toast } from "@/hooks/use-toast";
import Decimal from "decimal.js";
import { formatMoney } from "@/lib/format";
import type { CauseSuggestion } from "@/lib/calc/balance-sync";

type AccountLite = {
  id: string;
  name: string;
  currency: string;
  currentBalance: Decimal | string;
};

type CheckResult = {
  checkId: string;
  appBalance: string;
  brokerBalance: string;
  difference: string;
  percentDiff: string;
  isMatched: boolean;
  causes: CauseSuggestion[];
};

export function BalanceCheckDialog({
  account,
  triggerVariant = "button",
  triggerLabel = "Check balance",
  open: openProp,
  onOpenChange: onOpenChangeProp,
  children,
}: {
  account: AccountLite;
  triggerVariant?: "button" | "banner" | "none";
  triggerLabel?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  children?: React.ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChangeProp ?? setInternalOpen;

  const [brokerBalance, setBrokerBalance] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const brokerInputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the broker balance input when the dialog opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => brokerInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  function reset() {
    setBrokerBalance("");
    setNote("");
    setResult(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const fd = new FormData();
    fd.set("tradingAccountId", account.id);
    fd.set("brokerBalance", brokerBalance);
    startTransition(async () => {
      const res = await createBalanceCheckAction(fd);
      if (!res.ok) {
        toast({ title: "Check failed", description: res.message, variant: "destructive" });
        return;
      }
      setResult({
        checkId: res.checkId!,
        appBalance: res.appBalance!,
        brokerBalance: res.brokerBalance!,
        difference: res.difference!,
        percentDiff: res.percentDiff!,
        isMatched: res.isMatched!,
        causes: res.causes ?? [],
      });
      if (res.isMatched) {
        toast({
          title: "Matched",
          description: res.message,
        });
      }
    });
  }

  function onAdjust() {
    if (!result) return;
    const fd = new FormData();
    fd.set("checkId", result.checkId);
    fd.set("resolution", "ADJUSTED");
    fd.set("note", note);
    startTransition(async () => {
      const res = await resolveBalanceCheckAction(fd);
      if (!res.ok) {
        toast({ title: "Adjustment failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Adjustment recorded", description: res.message });
      close();
      router.refresh();
    });
  }

  function onIgnore() {
    if (!result) return;
    const fd = new FormData();
    fd.set("checkId", result.checkId);
    fd.set("resolution", "IGNORED");
    fd.set("note", note);
    startTransition(async () => {
      const res = await resolveBalanceCheckAction(fd);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Mismatch ignored", description: res.message });
      close();
      router.refresh();
    });
  }

  const computed = new Decimal(account.currentBalance.toString());
  const diff = result ? new Decimal(result.difference) : new Decimal(0);
  const positive = diff.gt(0);

  const trigger =
    triggerVariant === "none" ? null : triggerVariant === "banner" ? (
      children
    ) : (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent"
        data-testid="balance-check-trigger"
      >
        <Scale className="size-4" aria-hidden="true" />
        {triggerLabel}
      </button>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="balance-check-dialog">
        <DialogHeader>
          <DialogTitle>Verify your broker balance</DialogTitle>
          <DialogDescription>
            Enter the balance your broker shows right now for{" "}
            <span className="font-medium">{account.name}</span>. We compare it to our books and help
            you fix any difference.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
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
              ref={brokerInputRef}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={brokerBalance}
              onChange={(e) => setBrokerBalance(e.target.value)}
              disabled={pending || !!result}
              placeholder="0.00"
              data-testid="broker-balance-input"
            />
          </FormField>

          {result && (
            <div
              className={`rounded-md p-3 text-sm border ${
                result.isMatched
                  ? "bg-profit/10 border-profit/30 text-profit"
                  : "bg-warning/10 border-warning/30 text-warning"
              }`}
              data-testid="balance-check-result"
            >
              <div className="flex items-center gap-2 font-medium">
                {result.isMatched ? (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-4" aria-hidden="true" />
                )}
                {result.isMatched
                  ? "Matched — within tolerance."
                  : `Mismatch — broker is ${positive ? "ahead" : "behind"} by ${diff.abs().toFixed(2)} ${account.currency} (${result.percentDiff}% off).`}
              </div>
            </div>
          )}

          {result && !result.isMatched && (
            <>
              <FormField label="Note (optional)" htmlFor="note">
                <Textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={pending}
                  placeholder="What do you think caused this difference?"
                  rows={2}
                  data-testid="balance-check-note"
                />
              </FormField>

              {result.causes.length > 0 && <PossibleCausesPanel causes={result.causes} />}

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={close}
                  disabled={pending}
                  data-testid="balance-check-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onIgnore}
                  disabled={pending}
                  data-testid="balance-check-ignore"
                >
                  Ignore with note
                </Button>
                <Button
                  type="button"
                  onClick={onAdjust}
                  disabled={pending}
                  data-testid="balance-check-adjust"
                >
                  {pending
                    ? "Recording…"
                    : `Create adjustment (${positive ? "+" : "−"}${diff.abs().toFixed(2)})`}
                </Button>
              </DialogFooter>
            </>
          )}

          {(!result || result.isMatched) && (
            <DialogFooter>
              {result?.isMatched ? (
                <Button type="button" onClick={close} data-testid="balance-check-done">
                  Done
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={pending || !brokerBalance}
                  data-testid="balance-check-submit"
                >
                  {pending ? "Computing…" : "Compare balance"}
                </Button>
              )}
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── PossibleCausesPanel ────────────────────────────────────────────────────

function PossibleCausesPanel({ causes }: { causes: CauseSuggestion[] }) {
  return (
    <div
      className="rounded-md border border-info/30 bg-info/5 p-3 space-y-2"
      data-testid="balance-check-causes"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-info">
        <Wand2 className="size-4" aria-hidden="true" />
        Possible causes
      </div>
      <ul className="space-y-1.5">
        {causes.map((c, i) => (
          <li key={`${c.kind}-${i}`} className="text-xs">
            <div className="font-medium">{c.title}</div>
            <div className="text-muted-foreground">{c.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
