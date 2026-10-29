"use client";

/**
 * Phase 29 — Market-rating warning settings card (Settings page).
 *
 * Controls:
 *   - Show the live GOOD/CAUTION/AVOID warnings in the Add Trade flow.
 *   - Skip the AVOID confirm dialog on DEMO accounts (badge still shows).
 *   - AVOID-discipline weight (0–10): points the daily discipline score loses
 *     when a trade is saved after ignoring an AVOID warning. 0 disables it.
 *
 * Persisted on the User row via updateMarketWarningSettingsAction + audit log.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateMarketWarningSettingsAction } from "@/server/actions/market-edge";
import { toast } from "@/hooks/use-toast";
import { Activity } from "lucide-react";

export type MarketWarningSettings = {
  warningsEnabled: boolean;
  ignoreAvoidOnDemo: boolean;
  avoidOverrideWeight: number;
};

export function MarketWarningSettingsForm({ defaults }: { defaults: MarketWarningSettings }) {
  const [warningsEnabled, setWarningsEnabled] = useState(defaults.warningsEnabled);
  const [ignoreAvoidOnDemo, setIgnoreAvoidOnDemo] = useState(defaults.ignoreAvoidOnDemo);
  const [avoidOverrideWeight, setAvoidOverrideWeight] = useState(
    String(defaults.avoidOverrideWeight),
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("warningsEnabled", warningsEnabled ? "true" : "false");
    fd.set("ignoreAvoidOnDemo", ignoreAvoidOnDemo ? "true" : "false");
    fd.set("avoidOverrideWeight", avoidOverrideWeight);
    startTransition(async () => {
      const res = await updateMarketWarningSettingsAction(fd);
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
        <Activity className="size-4" aria-hidden="true" />
        Market-rating warnings
      </h2>
      <p className="text-xs text-muted-foreground">
        Live condition ratings (GOOD / CAUTION / AVOID) for the pair you&apos;re about to trade.
        Ratings describe current market conditions — they are advisory and never block a trade.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="mw-enabled" className="text-sm font-medium">
              Show market warnings
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Rating badge next to the pair in Add Trade, plus rating + your history on the
              pre-trade confirmation screen.
            </p>
          </div>
          <Switch
            id="mw-enabled"
            checked={warningsEnabled}
            onCheckedChange={(v) => setWarningsEnabled(v === true)}
            disabled={pending}
            data-testid="market-warnings-switch"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="mw-ignore-demo" className="text-sm font-medium">
              Skip AVOID confirmation on DEMO
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Demo accounts keep the rating badge but won&apos;t get the confirm dialog. Real-money
              trades always confirm.
            </p>
          </div>
          <Switch
            id="mw-ignore-demo"
            checked={ignoreAvoidOnDemo}
            onCheckedChange={(v) => setIgnoreAvoidOnDemo(v === true)}
            disabled={pending}
            data-testid="market-warnings-demo-switch"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <div>
            <Label htmlFor="mw-weight" className="text-sm font-medium">
              AVOID discipline weight (0–10)
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              Points the daily discipline score loses when you save a trade after ignoring an
              AVOID warning. 0 turns the deduction off.
            </p>
            <Input
              id="mw-weight"
              type="number"
              min={0}
              max={10}
              step={1}
              value={avoidOverrideWeight}
              onChange={(e) => setAvoidOverrideWeight(e.target.value)}
              disabled={pending}
              data-testid="market-warnings-weight-input"
            />
          </div>
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="market-warnings-save">
          {pending ? "Saving…" : "Save warning settings"}
        </Button>
      </form>
    </Card>
  );
}
