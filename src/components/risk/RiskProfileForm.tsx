"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/trader/FormField";
import { FormError, FormSuccess } from "@/components/auth/AuthShell";
import { upsertRiskProfileAction } from "@/server/actions/risk-rules";
import { toast } from "@/hooks/use-toast";
import Decimal from "decimal.js";

type Defaults = {
  riskPerTradePercent: number;
  maxDailyLossPercent: number;
  maxDailyLossAmount: number | null;
  dailyProfitTargetPercent: number | null;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  maxOpenTrades: number;
  weeklyLossLimitPercent: number | null;
  lockoutEnabled: boolean;
};

/**
 * RiskProfileForm — editable form for all 9 RiskProfile fields.
 * Multi-section layout: Risk per trade / Daily limits / Streaks & cooldown /
 * Open trades & weekly / Lockout toggle.
 */
export function RiskProfileForm({
  account,
  defaults,
}: {
  account: { id: string; name: string; currency: string };
  defaults: Defaults;
}) {
  const [form, setForm] = useState<Defaults>(defaults);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function set<K extends keyof Defaults>(key: K, value: Defaults[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setError(undefined);
    setSuccess(undefined);
    const fd = new FormData();
    fd.set("tradingAccountId", account.id);
    fd.set("riskPerTradePercent", String(form.riskPerTradePercent));
    fd.set("maxDailyLossPercent", String(form.maxDailyLossPercent));
    fd.set("maxDailyLossAmount", form.maxDailyLossAmount ? String(form.maxDailyLossAmount) : "");
    fd.set(
      "dailyProfitTargetPercent",
      form.dailyProfitTargetPercent ? String(form.dailyProfitTargetPercent) : "",
    );
    fd.set("maxTradesPerDay", String(form.maxTradesPerDay));
    fd.set("maxConsecutiveLosses", String(form.maxConsecutiveLosses));
    fd.set("cooldownMinutes", String(form.cooldownMinutes));
    fd.set("maxOpenTrades", String(form.maxOpenTrades));
    fd.set(
      "weeklyLossLimitPercent",
      form.weeklyLossLimitPercent ? String(form.weeklyLossLimitPercent) : "",
    );
    fd.set("lockoutEnabled", form.lockoutEnabled ? "true" : "false");
    startTransition(async () => {
      const res = await upsertRiskProfileAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      toast({ title: "Risk profile saved", description: res.message });
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {/* Section 1: Risk per trade */}
      <section className="rounded-lg border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Risk per trade
        </h2>
        <FormField
          label="Risk per trade (%)"
          htmlFor="riskPerTradePercent"
          error={fieldErrors.riskPerTradePercent}
          required
          hint={`With current balance, this caps your max stake at ${new Decimal(0).toString()} (computed by the Add Trade form).`}
        >
          <Input
            id="riskPerTradePercent"
            type="number"
            step="0.1"
            min="0.1"
            max="50"
            value={form.riskPerTradePercent}
            onChange={(e) => set("riskPerTradePercent", Number(e.target.value))}
            disabled={pending}
          />
        </FormField>
      </section>

      {/* Section 2: Daily limits */}
      <section className="rounded-lg border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Daily limits
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FormField
            label="Max daily loss (%)"
            htmlFor="maxDailyLossPercent"
            error={fieldErrors.maxDailyLossPercent}
            required
            hint="When you hit this in a day, auto-lockout until your next midnight."
          >
            <Input
              id="maxDailyLossPercent"
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              value={form.maxDailyLossPercent}
              onChange={(e) => set("maxDailyLossPercent", Number(e.target.value))}
              disabled={pending}
            />
          </FormField>
          <FormField
            label="Max daily loss amount (optional)"
            htmlFor="maxDailyLossAmount"
            error={fieldErrors.maxDailyLossAmount}
            hint={`In ${account.currency}. Overrides the % cap if smaller.`}
          >
            <Input
              id="maxDailyLossAmount"
              type="number"
              step="0.01"
              min="0"
              value={form.maxDailyLossAmount ?? ""}
              onChange={(e) =>
                set("maxDailyLossAmount", e.target.value ? Number(e.target.value) : null)
              }
              disabled={pending}
              placeholder="—"
            />
          </FormField>
          <FormField
            label="Daily profit target (%)"
            htmlFor="dailyProfitTargetPercent"
            error={fieldErrors.dailyProfitTargetPercent}
            hint="Stop-when-ahead: lockout for the rest of the day if reached."
          >
            <Input
              id="dailyProfitTargetPercent"
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={form.dailyProfitTargetPercent ?? ""}
              onChange={(e) =>
                set("dailyProfitTargetPercent", e.target.value ? Number(e.target.value) : null)
              }
              disabled={pending}
              placeholder="—"
            />
          </FormField>
        </div>
      </section>

      {/* Section 3: Streaks + cooldown */}
      <section className="rounded-lg border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Streaks &amp; cooldown
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            label="Max consecutive losses"
            htmlFor="maxConsecutiveLosses"
            error={fieldErrors.maxConsecutiveLosses}
            required
            hint="After N losses in a row, auto-cooldown."
          >
            <Input
              id="maxConsecutiveLosses"
              type="number"
              step="1"
              min="1"
              max="20"
              value={form.maxConsecutiveLosses}
              onChange={(e) => set("maxConsecutiveLosses", Number(e.target.value))}
              disabled={pending}
            />
          </FormField>
          <FormField
            label="Cooldown (minutes)"
            htmlFor="cooldownMinutes"
            error={fieldErrors.cooldownMinutes}
            required
            hint="How long the consecutive-loss lockout lasts."
          >
            <Input
              id="cooldownMinutes"
              type="number"
              step="1"
              min="0"
              max="1440"
              value={form.cooldownMinutes}
              onChange={(e) => set("cooldownMinutes", Number(e.target.value))}
              disabled={pending}
            />
          </FormField>
        </div>
      </section>

      {/* Section 4: Open trades + weekly */}
      <section className="rounded-lg border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Open trades &amp; weekly limit
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FormField
            label="Max open trades"
            htmlFor="maxOpenTrades"
            error={fieldErrors.maxOpenTrades}
            required
            hint="Block opening new trades if this many are still OPEN."
          >
            <Input
              id="maxOpenTrades"
              type="number"
              step="1"
              min="1"
              max="20"
              value={form.maxOpenTrades}
              onChange={(e) => set("maxOpenTrades", Number(e.target.value))}
              disabled={pending}
            />
          </FormField>
          <FormField
            label="Max trades per day"
            htmlFor="maxTradesPerDay"
            error={fieldErrors.maxTradesPerDay}
            required
            hint="Block new trades after this many close today."
          >
            <Input
              id="maxTradesPerDay"
              type="number"
              step="1"
              min="1"
              max="100"
              value={form.maxTradesPerDay}
              onChange={(e) => set("maxTradesPerDay", Number(e.target.value))}
              disabled={pending}
            />
          </FormField>
          <FormField
            label="Weekly loss limit (%)"
            htmlFor="weeklyLossLimitPercent"
            error={fieldErrors.weeklyLossLimitPercent}
            hint="Lockout until next week start (Sun 00:00 your TZ)."
          >
            <Input
              id="weeklyLossLimitPercent"
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={form.weeklyLossLimitPercent ?? ""}
              onChange={(e) =>
                set("weeklyLossLimitPercent", e.target.value ? Number(e.target.value) : null)
              }
              disabled={pending}
              placeholder="—"
            />
          </FormField>
        </div>
      </section>

      {/* Section 5: Lockout toggle */}
      <section className="rounded-lg border border-border p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Lockout enforcement
        </h2>
        <div className="flex items-center gap-3">
          <Switch
            id="lockoutEnabled"
            checked={form.lockoutEnabled}
            onCheckedChange={(v) => set("lockoutEnabled", v === true)}
            disabled={pending}
          />
          <label htmlFor="lockoutEnabled" className="text-sm font-medium cursor-pointer">
            Auto-create lockouts on breaches
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          When OFF, breaches still WARN but no lockouts are auto-created. Recommended ON for real
          accounts — keeps your discipline honest.
        </p>
      </section>

      <FormError message={error} />
      <FormSuccess message={success} />

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save risk profile"}
        </Button>
      </div>
    </form>
  );
}
