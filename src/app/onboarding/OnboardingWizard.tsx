"use client";

import { useState, useTransition, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completeOnboardingAction } from "@/server/actions/onboarding";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "NGN", "JPY", "AUD", "CAD"];
const COMMON_TIMEZONES = [
  "UTC",
  "Africa/Lagos",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Singapore",
];

const PASSWORD_RULES = ["At least 8 characters", "Upper + lower + digit + special"];

/**
 * Detect the browser's IANA timezone (e.g. "Africa/Lagos"). Returns "UTC" on
 * the server (where `Intl` would return the Node process TZ, which is wrong
 * for the user) and during hydration, then the real browser TZ on the next
 * render via useSyncExternalStore — tear-free hydration, no setState-in-effect.
 *
 * useSyncExternalStore requires a subscribe callback (we never actually
 * subscribe to anything — the timezone doesn't change without a reload); we
 * pass a no-op so React is happy.
 */
function useBrowserTimezone(): string {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    },
    () => "UTC",
  );
}

/**
 * Single-page onboarding form. (Originally a 3-step wizard; collapsed to one
 * page so the form is more keyboard-friendly, more reliable across browsers,
 * and easier to e2e test. The same data is submitted; the server action
 * `completeOnboardingAction` validates the whole payload at once.)
 *
 * Phase 25: the timezone select defaults to the browser's detected IANA
 * timezone (e.g. "Africa/Lagos") for first-time Google sign-up users who
 * haven't picked one yet. Existing credential-registered users also benefit.
 */
export function OnboardingWizard() {
  // Tear-free hydration of the browser's IANA timezone. Returns "UTC" on
  // the server, the real browser TZ on the client.
  const browserTimezone = useBrowserTimezone();

  const [form, setForm] = useState({
    baseCurrency: "USD",
    timezone: "UTC",
    accountName: "My Demo Account",
    broker: "",
    accountType: "DEMO" as "DEMO" | "REAL",
    startingBalance: "1000",
    riskPerTradePercent: "2",
    maxDailyLossPercent: "6",
    maxConsecutiveLosses: "3",
  });

  // Sync the form's timezone with the detected browser value whenever it
  // changes (i.e. on the second render after hydration). This is computed
  // during render, not in an effect, to comply with the React Compiler's
  // set-state-in-effect rule.
  if (form.timezone !== browserTimezone && browserTimezone !== "UTC") {
    setForm((f) => ({ ...f, timezone: browserTimezone }));
  }
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { update } = useSession();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("baseCurrency", form.baseCurrency);
    fd.set("timezone", form.timezone);
    fd.set("accountName", form.accountName);
    fd.set("broker", form.broker);
    fd.set("accountType", form.accountType);
    fd.set("startingBalance", form.startingBalance);
    fd.set("riskPerTradePercent", form.riskPerTradePercent);
    fd.set("maxDailyLossPercent", form.maxDailyLossPercent);
    fd.set("maxConsecutiveLosses", form.maxConsecutiveLosses);
    startTransition(async () => {
      const res = await completeOnboardingAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      // Refresh the JWT so middleware sees isOnboarded=true. The jwt callback
      // in @/lib/auth re-reads from DB on the "update" trigger. After the
      // update resolves, push to /app/dashboard — middleware will let us in.
      await update({ isOnboarded: true });
      setTimeout(() => {
        router.push("/app/dashboard");
        router.refresh();
      }, 400);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {/* Step 1: Locale */}
      <section className="space-y-3 pb-4 border-b border-border">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Step 1 · Locale
        </h2>
        <Field
          label="Base currency"
          htmlFor="baseCurrency"
          error={fieldErrors.baseCurrency}
          hint="Used to format balances and reports. Change later in Settings."
        >
          <select
            id="baseCurrency"
            value={form.baseCurrency}
            onChange={(e) => set("baseCurrency", e.target.value.toUpperCase())}
            disabled={pending}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Timezone"
          htmlFor="timezone"
          error={fieldErrors.timezone}
          hint="Used to define 'today' and 'this week' for risk-rule enforcement."
        >
          <select
            id="timezone"
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            disabled={pending}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {/* If the browser's detected timezone isn't in our curated list,
                surface it as the first option so it's selectable. */}
            {browserTimezone && !COMMON_TIMEZONES.includes(browserTimezone) && (
              <option value={browserTimezone}>{browserTimezone} (detected)</option>
            )}
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </section>

      {/* Step 2: First account */}
      <section className="space-y-3 pb-4 border-b border-border">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Step 2 · First trading account
        </h2>
        <Field label="Account name" htmlFor="accountName" error={fieldErrors.accountName}>
          <Input
            id="accountName"
            value={form.accountName}
            onChange={(e) => set("accountName", e.target.value)}
            disabled={pending}
          />
        </Field>
        <Field
          label="Broker"
          htmlFor="broker"
          error={fieldErrors.broker}
          hint="Where you actually trade — e.g. Quotex, PocketOption, Deriv, IQ Option."
        >
          <Input
            id="broker"
            value={form.broker}
            onChange={(e) => set("broker", e.target.value)}
            disabled={pending}
            placeholder="Quotex"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Account type" htmlFor="accountType">
            <div className="grid grid-cols-2 gap-1.5">
              {(["DEMO", "REAL"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set("accountType", t)}
                  className={`h-11 rounded-md border px-3 text-sm font-medium ${
                    form.accountType === t
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input bg-background hover:bg-accent"
                  }`}
                  disabled={pending}
                >
                  {t === "DEMO" ? "Demo" : "Real"}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="Starting balance"
            htmlFor="startingBalance"
            error={fieldErrors.startingBalance}
            hint={`In ${form.baseCurrency || "selected currency"}.`}
          >
            <Input
              id="startingBalance"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.startingBalance}
              onChange={(e) => set("startingBalance", e.target.value)}
              disabled={pending}
            />
          </Field>
        </div>
      </section>

      {/* Step 3: Risk profile */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Step 3 · Risk profile (defaults shown)
        </h2>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          <strong>Discipline first.</strong> These defaults (2% per trade, 6% daily loss, 3
          consecutive losses) are conservative starting points — most professional risk managers use
          them. You can tune them later on the Risk Rules page.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field
            label="Risk per trade (%)"
            htmlFor="riskPerTradePercent"
            error={fieldErrors.riskPerTradePercent}
          >
            <Input
              id="riskPerTradePercent"
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={form.riskPerTradePercent}
              onChange={(e) => set("riskPerTradePercent", e.target.value)}
              disabled={pending}
            />
          </Field>
          <Field
            label="Max daily loss (%)"
            htmlFor="maxDailyLossPercent"
            error={fieldErrors.maxDailyLossPercent}
          >
            <Input
              id="maxDailyLossPercent"
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              value={form.maxDailyLossPercent}
              onChange={(e) => set("maxDailyLossPercent", e.target.value)}
              disabled={pending}
            />
          </Field>
          <Field
            label="Max consec. losses"
            htmlFor="maxConsecutiveLosses"
            error={fieldErrors.maxConsecutiveLosses}
          >
            <Input
              id="maxConsecutiveLosses"
              type="number"
              step="1"
              min="1"
              max="20"
              value={form.maxConsecutiveLosses}
              onChange={(e) => set("maxConsecutiveLosses", e.target.value)}
              disabled={pending}
            />
          </Field>
        </div>
      </section>

      <FormError message={error} />
      <FormSuccess message={success} />

      <Button type="submit" disabled={pending} className="w-full h-11">
        {pending ? "Setting up…" : "Finish & enter RiskGuard"}
      </Button>
    </form>
  );
}
