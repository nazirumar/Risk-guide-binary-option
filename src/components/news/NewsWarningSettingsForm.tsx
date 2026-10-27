"use client";

/**
 * Phase 22 — News warning settings card (Settings page).
 *
 * Controls:
 *   - newsWarningEnabled (toggle on/off).
 *   - newsWarningMinutes (0–240; default 15). 0 = effectively disables the
 *     warning (the pure calc uses strict less-than, so a 0-minute window
 *     never fires).
 *
 * Persisted on the User row via updateNewsWarningSettingsAction + audit log.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateNewsWarningSettingsAction } from "@/server/actions/news";
import { toast } from "@/hooks/use-toast";
import { Newspaper } from "lucide-react";

export type NewsWarningSettings = {
  enabled: boolean;
  minutes: number;
};

export function NewsWarningSettingsForm({ defaults }: { defaults: NewsWarningSettings }) {
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [minutes, setMinutes] = useState(String(defaults.minutes));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("newsWarningEnabled", enabled ? "true" : "false");
    fd.set("newsWarningMinutes", minutes);
    startTransition(async () => {
      const res = await updateNewsWarningSettingsAction(fd);
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
        <Newspaper className="size-4" aria-hidden="true" />
        News warning
      </h2>
      <p className="text-xs text-muted-foreground">
        When you save a trade in the Add Trade form, RiskGuard checks the news calendar for upcoming
        high-impact events that affect the traded pair&apos;s currencies. If any are within the
        warning window, a non-blocking red panel surfaces beneath the asset selector. You can still
        save the trade — the warning is a discipline aid, not a hard block.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="news-warning-enabled" className="text-sm font-medium">
              Enable news warning
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Turn off to suppress the warning entirely.
            </p>
          </div>
          <Switch
            id="news-warning-enabled"
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
            disabled={pending}
          />
        </div>
        <div>
          <Label htmlFor="news-warning-minutes" className="text-sm font-medium">
            Warning window (minutes, 0–240)
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
            Fires when a high-impact event is within this many minutes before or after the trade
            time. 15 is the default; 0 disables.
          </p>
          <Input
            id="news-warning-minutes"
            type="number"
            min={0}
            max={240}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            disabled={pending}
            data-testid="news-warning-minutes-input"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending} data-testid="news-warning-save">
          {pending ? "Saving…" : "Save news settings"}
        </Button>
      </form>
    </Card>
  );
}
