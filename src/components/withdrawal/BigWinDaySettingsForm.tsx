"use client";

/**
 * Phase 19 — Big-win-day settings form (Settings page).
 *
 * Optional rule: when todayPL/balance >= this percent, the dashboard surfaces
 * a "Stop trading and bank some profit" banner. Empty input or 0 disables
 * the prompt (server stores null).
 *
 * Persisted on the User row via updateBigWinDaySettingsAction + audit log.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateBigWinDaySettingsAction } from "@/server/actions/withdrawals";
import { toast } from "@/hooks/use-toast";
import { TrendingUp } from "lucide-react";

export type BigWinDaySettings = {
  bigWinDayPercent: number | null;
};

export function BigWinDaySettingsForm({ defaults }: { defaults: BigWinDaySettings }) {
  const [percent, setPercent] = useState(
    defaults.bigWinDayPercent == null ? "" : String(defaults.bigWinDayPercent),
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("bigWinDayPercent", percent);
    startTransition(async () => {
      const res = await updateBigWinDaySettingsAction(fd);
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
        <TrendingUp className="size-4" aria-hidden="true" />
        Big-win-day prompt
      </h2>
      <p className="text-xs text-muted-foreground">
        Optional. When today&rsquo;s P/L is at least this percent of your account balance, the
        dashboard surfaces a &ldquo;Stop trading and bank some profit&rdquo; banner. Leave empty or
        0 to disable — the prompt never fires.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="bwd-percent" className="text-sm font-medium">
            Threshold (%, 0–1000)
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
            20 means a $200 win on a $1,000 balance triggers the prompt. Most traders set 15–30.
          </p>
          <Input
            id="bwd-percent"
            type="number"
            min={0}
            max={1000}
            step={1}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            disabled={pending}
            placeholder="Leave empty to disable"
            data-testid="bwd-percent-input"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending} data-testid="bwd-save">
          {pending ? "Saving…" : "Save big-win-day settings"}
        </Button>
      </form>
    </Card>
  );
}
