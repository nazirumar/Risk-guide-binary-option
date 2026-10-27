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
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/trader/FormField";
import { Input } from "@/components/ui/input";
import { createTradingAccountAction } from "@/server/actions/accounts";
import { toast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "NGN", "JPY", "AUD", "CAD"];

export function CreateAccountDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    broker: "",
    currency: "USD",
    type: "DEMO" as "DEMO" | "REAL",
    startingBalance: "1000",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    const fd = new FormData();
    fd.set("name", form.name);
    fd.set("broker", form.broker);
    fd.set("currency", form.currency);
    fd.set("type", form.type);
    fd.set("startingBalance", form.startingBalance);
    startTransition(async () => {
      const res = await createTradingAccountAction(fd);
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        toast({ title: "Create failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Account created", description: res.message });
      setOpen(false);
      setForm({ name: "", broker: "", currency: "USD", type: "DEMO", startingBalance: "1000" });
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a trading account</DialogTitle>
          <DialogDescription>
            Track deposits, withdrawals, trades, and discipline on this broker account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label="Account name" htmlFor="name" error={fieldErrors.name} required>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={pending}
              placeholder="Quotex Demo"
            />
          </FormField>
          <FormField label="Broker" htmlFor="broker" error={fieldErrors.broker} required>
            <Input
              id="broker"
              value={form.broker}
              onChange={(e) => setForm({ ...form, broker: e.target.value })}
              disabled={pending}
              placeholder="Quotex"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Currency" htmlFor="currency" error={fieldErrors.currency}>
              <select
                id="currency"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                disabled={pending}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Account type" htmlFor="type">
              <div className="grid grid-cols-2 gap-1.5">
                {(["DEMO", "REAL"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm({ ...form, type: t })}
                    className={`h-11 rounded-md border px-3 text-sm font-medium ${
                      form.type === t
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input bg-background hover:bg-accent"
                    }`}
                    disabled={pending}
                  >
                    {t === "DEMO" ? "Demo" : "Real"}
                  </button>
                ))}
              </div>
            </FormField>
          </div>
          <FormField
            label="Starting balance"
            htmlFor="startingBalance"
            error={fieldErrors.startingBalance}
            required
            hint="In your selected currency. A DEPOSIT transaction is auto-recorded so the cash-flow ledger matches from day one."
          >
            <Input
              id="startingBalance"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.startingBalance}
              onChange={(e) => setForm({ ...form, startingBalance: e.target.value })}
              disabled={pending}
            />
          </FormField>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
