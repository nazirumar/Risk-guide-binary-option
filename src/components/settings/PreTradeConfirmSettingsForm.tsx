"use client";

/**
 * Phase 17 — Pre-trade confirmation settings card (Settings page).
 *
 * Controls:
 *   - Skip the confirmation screen on DEMO accounts (REAL always confirms).
 *   - Cooldown seconds (0–15) before "Confirm trade" unlocks.
 *   - Require the "This trade follows my plan" checkbox.
 *   - Reason for entry: OFF / OPTIONAL / REQUIRED.
 *
 * Persisted on the User row via updatePreTradeSettingsAction + audit log.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updatePreTradeSettingsAction } from "@/server/actions/pre-trade";
import { toast } from "@/hooks/use-toast";
import { ShieldCheck } from "lucide-react";

export type PreTradeConfirmSettings = {
  skipDemo: boolean;
  cooldownSeconds: number;
  requirePlanCheckbox: boolean;
  reasonMode: "OFF" | "OPTIONAL" | "REQUIRED";
};

export function PreTradeConfirmSettingsForm({ defaults }: { defaults: PreTradeConfirmSettings }) {
  const [skipDemo, setSkipDemo] = useState(defaults.skipDemo);
  const [cooldownSeconds, setCooldownSeconds] = useState(String(defaults.cooldownSeconds));
  const [requirePlanCheckbox, setRequirePlanCheckbox] = useState(defaults.requirePlanCheckbox);
  const [reasonMode, setReasonMode] = useState(defaults.reasonMode);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("skipDemo", skipDemo ? "true" : "false");
    fd.set("cooldownSeconds", cooldownSeconds);
    fd.set("requirePlanCheckbox", requirePlanCheckbox ? "true" : "false");
    fd.set("reasonMode", reasonMode);
    startTransition(async () => {
      const res = await updatePreTradeSettingsAction(fd);
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
        <ShieldCheck className="size-4" aria-hidden="true" />
        Pre-trade confirmation
      </h2>
      <p className="text-xs text-muted-foreground">
        The confirmation screen appears after you press &ldquo;Save trade&rdquo; and shows every
        number of the trade before it is saved. REAL accounts always confirm; the cooldown, plan
        checkbox and entry reason below apply to every confirmation.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="ptc-skip-demo" className="text-sm font-medium">
              Skip on DEMO accounts
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Turn the confirmation screen off for demo accounts only. Real-money trades always
              confirm.
            </p>
          </div>
          <Switch
            id="ptc-skip-demo"
            checked={skipDemo}
            onCheckedChange={(v) => setSkipDemo(v === true)}
            disabled={pending}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="ptc-cooldown" className="text-sm font-medium">
              Cooldown (seconds, 0–15)
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              &ldquo;Confirm trade&rdquo; stays disabled for this long — and the server rejects
              early confirms too.
            </p>
            <Input
              id="ptc-cooldown"
              type="number"
              min={0}
              max={15}
              step={1}
              value={cooldownSeconds}
              onChange={(e) => setCooldownSeconds(e.target.value)}
              disabled={pending}
              data-testid="ptc-cooldown-input"
            />
          </div>
          <div>
            <Label htmlFor="ptc-reason-mode" className="text-sm font-medium">
              Reason for entry
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
              A quick &ldquo;why am I taking this trade?&rdquo; field in the modal.
            </p>
            <select
              id="ptc-reason-mode"
              value={reasonMode}
              onChange={(e) => setReasonMode(e.target.value as typeof reasonMode)}
              disabled={pending}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="ptc-reason-mode-select"
            >
              <option value="OFF">Off — don&apos;t ask</option>
              <option value="OPTIONAL">Optional</option>
              <option value="REQUIRED">Required</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="ptc-plan-checkbox" className="text-sm font-medium">
              Require &ldquo;This trade follows my plan&rdquo; checkbox
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The confirm button stays locked until the box is checked. The answer is saved with the
              trade.
            </p>
          </div>
          <Switch
            id="ptc-plan-checkbox"
            checked={requirePlanCheckbox}
            onCheckedChange={(v) => setRequirePlanCheckbox(v === true)}
            disabled={pending}
          />
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="ptc-save">
          {pending ? "Saving…" : "Save confirmation settings"}
        </Button>
      </form>
    </Card>
  );
}
