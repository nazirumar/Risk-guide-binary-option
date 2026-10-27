"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/trader/FormField";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createTransactionAction } from "@/server/actions/transactions";
import { toast } from "@/hooks/use-toast";
import Decimal from "decimal.js";

type AccountLite = {
  id: string;
  name: string;
  currency: string;
  currentBalance: Decimal | string;
};

const TYPES = [
  { value: "DEPOSIT", label: "Deposit", desc: "Add money to the broker" },
  { value: "WITHDRAWAL", label: "Withdrawal", desc: "Take money out" },
  { value: "BONUS", label: "Bonus", desc: "Broker credited you" },
  { value: "ADJUSTMENT", label: "Adjustment", desc: "Reconcile against broker statement" },
] as const;

/**
 * CreateTransactionDialog — record a DEPOSIT/WITHDRAWAL/BONUS/ADJUSTMENT.
 * The amount is always positive in the form; the server-action sign-handling
 * (signedTransactionAmount) takes care of the +/- accounting.
 */
export function CreateTransactionDialog({
  account,
  children,
}: {
  account: AccountLite;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    type: "DEPOSIT" as "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT",
    amount: "",
    note: "",
    occurredAt: new Date().toISOString().slice(0, 10),
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    const fd = new FormData();
    fd.set("tradingAccountId", account.id);
    fd.set("type", form.type);
    fd.set("amount", form.amount);
    fd.set("note", form.note);
    fd.set("occurredAt", form.occurredAt);
    startTransition(async () => {
      const res = await createTransactionAction(fd);
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({
        title: "Transaction recorded",
        description: res.message,
      });
      if (res.warning) {
        toast({
          title: "Heads up",
          description: res.warning,
        });
      }
      setOpen(false);
      setForm({ ...form, amount: "", note: "" });
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a transaction</DialogTitle>
          <DialogDescription>
            {account.name} · Current balance:{" "}
            <span className="font-medium tabular-nums">
              {new Decimal(account.currentBalance.toString()).toFixed(2)} {account.currency}
            </span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {/* Type selector */}
          <FormField label="Type" htmlFor="type">
            <div className="grid grid-cols-2 gap-1.5">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm({ ...form, type: t.value })}
                  className={`h-auto py-2 px-3 rounded-md border text-left ${
                    form.type === t.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input bg-background hover:bg-accent"
                  }`}
                  disabled={pending}
                  aria-pressed={form.type === t.value}
                >
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">{t.desc}</div>
                </button>
              ))}
            </div>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Amount"
              htmlFor="amount"
              error={fieldErrors.amount}
              required
              hint={`In ${account.currency}. Always positive — the server handles +/- accounting.`}
            >
              <Input
                id="amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                disabled={pending}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="Date" htmlFor="occurredAt" error={fieldErrors.occurredAt}>
              <Input
                id="occurredAt"
                type="date"
                value={form.occurredAt}
                onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
                disabled={pending}
              />
            </FormField>
          </div>

          <FormField label="Note (optional)" htmlFor="note" error={fieldErrors.note}>
            <Input
              id="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              disabled={pending}
              placeholder="Bonus credit / Withdrawn to bank / etc."
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Recording…" : "Record transaction"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
