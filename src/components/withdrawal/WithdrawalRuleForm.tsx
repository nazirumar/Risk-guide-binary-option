"use client";

/**
 * Phase 19 — Withdrawal rule create / edit form.
 *
 * One form serves both create and edit. When `existing` is provided, the form
 * is in edit mode and pre-fills from the rule; otherwise it's a new-rule
 * form for the given account.
 *
 * Fields: type (select), value (number), frequency (select), baseline
 * (select), isActive (switch). On submit → createWithdrawalRuleAction or
 * updateWithdrawalRuleAction.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  createWithdrawalRuleAction,
  updateWithdrawalRuleAction,
} from "@/server/actions/withdrawals";
import { toast } from "@/hooks/use-toast";

export type ExistingRule = {
  id: string;
  type: "PERCENT_OF_PROFIT" | "FIXED_AMOUNT" | "BALANCE_ABOVE_THRESHOLD";
  value: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  baseline: "STARTING_BALANCE" | "LAST_WITHDRAWAL" | "HIGH_WATER_MARK";
  isActive: boolean;
};

export function WithdrawalRuleForm({
  tradingAccountId,
  existing,
}: {
  tradingAccountId: string;
  existing?: ExistingRule;
}) {
  const [type, setType] = useState(existing?.type ?? "PERCENT_OF_PROFIT");
  const [value, setValue] = useState(existing?.value ?? "20");
  const [frequency, setFrequency] = useState(existing?.frequency ?? "WEEKLY");
  const [baseline, setBaseline] = useState(existing?.baseline ?? "STARTING_BALANCE");
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("tradingAccountId", tradingAccountId);
    fd.set("type", type);
    fd.set("value", value);
    fd.set("frequency", frequency);
    fd.set("baseline", baseline);
    fd.set("isActive", isActive ? "true" : "false");
    if (existing) fd.set("ruleId", existing.id);

    startTransition(async () => {
      const res = existing
        ? await updateWithdrawalRuleAction(fd)
        : await createWithdrawalRuleAction(fd);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Saved", description: res.message });
      router.refresh();
    });
  }

  const valueLabel =
    type === "PERCENT_OF_PROFIT"
      ? "Percent of profit (0–100)"
      : type === "FIXED_AMOUNT"
        ? "Fixed amount"
        : "Balance threshold";

  return (
    <Card className="p-5 space-y-4">
      <h3 className="text-sm font-semibold">{existing ? "Edit rule" : "New withdrawal rule"}</h3>
      <form onSubmit={onSubmit} className="space-y-4" data-testid="withdrawal-rule-form">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="wr-type" className="text-sm font-medium">
              Rule type
            </Label>
            <select
              id="wr-type"
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              disabled={pending}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="wr-type-select"
            >
              <option value="PERCENT_OF_PROFIT">% of profit (e.g. 20% of profit)</option>
              <option value="FIXED_AMOUNT">Fixed amount (e.g. $50)</option>
              <option value="BALANCE_ABOVE_THRESHOLD">Everything above balance threshold</option>
            </select>
          </div>
          <div>
            <Label htmlFor="wr-value" className="text-sm font-medium">
              {valueLabel}
            </Label>
            <Input
              id="wr-value"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={pending}
              className="mt-1"
              data-testid="wr-value-input"
            />
          </div>
          <div>
            <Label htmlFor="wr-frequency" className="text-sm font-medium">
              Frequency
            </Label>
            <select
              id="wr-frequency"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as typeof frequency)}
              disabled={pending}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="wr-frequency-select"
            >
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </div>
          <div>
            <Label htmlFor="wr-baseline" className="text-sm font-medium">
              Baseline (what counts as profit)
            </Label>
            <select
              id="wr-baseline"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value as typeof baseline)}
              disabled={pending}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="wr-baseline-select"
            >
              <option value="STARTING_BALANCE">From starting balance</option>
              <option value="LAST_WITHDRAWAL">Since last withdrawal</option>
              <option value="HIGH_WATER_MARK">From high-water mark (peak)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="wr-active" className="text-sm font-medium">
              Active
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Inactive rules don&rsquo;t surface reminders. Toggle to pause without deleting.
            </p>
          </div>
          <Switch
            id="wr-active"
            checked={isActive}
            onCheckedChange={(v) => setIsActive(v === true)}
            disabled={pending}
          />
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="wr-save">
          {pending ? "Saving…" : existing ? "Update rule" : "Create rule"}
        </Button>
      </form>
    </Card>
  );
}
