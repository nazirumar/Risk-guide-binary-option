"use client";

/**
 * Phase 18 — Balance Sync settings card (Settings page).
 *
 * Controls:
 *   - Tolerance percent (0–100; default 0.5 = 0.5%) — the threshold below
 *     which a balance check auto-resolves MATCHED.
 *   - Reminder frequency (DAILY / WEEKLY / OFF) — how often the dashboard
 *     banner prompts the trader to verify their broker balance.
 *
 * Persisted on the User row via updateBalanceSyncSettingsAction + audit log.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateBalanceSyncSettingsAction } from "@/server/actions/balance-sync";
import { toast } from "@/hooks/use-toast";
import { RefreshCw } from "lucide-react";

export type BalanceSyncSettings = {
  tolerancePercent: number;
  reminderFrequency: "DAILY" | "WEEKLY" | "OFF";
};

export function BalanceSyncSettingsForm({ defaults }: { defaults: BalanceSyncSettings }) {
  const [tolerancePercent, setTolerancePercent] = useState(String(defaults.tolerancePercent));
  const [reminderFrequency, setReminderFrequency] = useState(defaults.reminderFrequency);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("tolerancePercent", tolerancePercent);
    fd.set("reminderFrequency", reminderFrequency);
    startTransition(async () => {
      const res = await updateBalanceSyncSettingsAction(fd);
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <RefreshCw className="size-4" aria-hidden="true" />
        Balance sync
      </h2>
      <p className="text-xs text-muted-foreground">
        Periodically check your broker&apos;s real balance against the app&apos;s books. The
        tolerance sets how close a broker balance needs to be to count as MATCHED; the reminder
        controls how often the dashboard banner nudges you to verify.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="bs-tolerance" className="text-sm font-medium">
              Tolerance (%, 0–100)
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              0.5 means 0.5% — a $5 difference on a $1,000 balance still matches.
            </p>
            <Input
              id="bs-tolerance"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={tolerancePercent}
              onChange={(e) => setTolerancePercent(e.target.value)}
              disabled={pending}
              data-testid="bs-tolerance-input"
            />
          </div>
          <div>
            <Label htmlFor="bs-frequency" className="text-sm font-medium">
              Reminder frequency
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              Daily is recommended — keeps your accuracy score honest.
            </p>
            <select
              id="bs-frequency"
              value={reminderFrequency}
              onChange={(e) => setReminderFrequency(e.target.value as typeof reminderFrequency)}
              disabled={pending}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="bs-frequency-select"
            >
              <option value="DAILY">Daily — first login of each day</option>
              <option value="WEEKLY">Weekly — first login of each week</option>
              <option value="OFF">Off — never prompt</option>
            </select>
          </div>
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="bs-save">
          {pending ? "Saving…" : "Save sync settings"}
        </Button>
      </form>
    </Card>
  );
}
