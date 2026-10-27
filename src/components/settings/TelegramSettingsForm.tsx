"use client";

/**
 * Phase 23 — Telegram settings card (Settings page).
 *
 * Three sections:
 *   1. Link/unlink flow: generate a one-time code (15-min expiry) → user
 *      sends /start CODE to the bot → webhook links the account. Unlink
 *      deletes the TelegramLink row.
 *   2. Master switch + per-alert toggles (the TELEGRAM_ALERT_TYPES list).
 *   3. Daily summary time (HH:MM in the user's TZ; empty = no daily summary).
 *
 * The form polls for link status via router.refresh() after generating a
 * code — the actual link happens via the Telegram webhook.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  generateLinkCodeAction,
  unlinkTelegramAction,
  updateTelegramAlertsAction,
} from "@/server/actions/telegram";
import { TELEGRAM_ALERT_TYPES } from "@/server/lib/notification-types";
import { toast } from "@/hooks/use-toast";
import { Send, Link2, Unlink } from "lucide-react";

export type TelegramSettings = {
  linked: boolean;
  username: string | null;
  chatId: string | null;
  alertsEnabled: boolean;
  alertsPaused: boolean;
  dailySummaryTime: string | null;
  prefs: Record<string, { inApp: boolean; email: boolean; telegram?: boolean }>;
};

export function TelegramSettingsForm({ settings }: { settings: TelegramSettings }) {
  const [alertsEnabled, setAlertsEnabled] = useState(settings.alertsEnabled);
  const [dailySummaryTime, setDailySummaryTime] = useState(settings.dailySummaryTime ?? "");
  const [pending, startTransition] = useTransition();
  const [pendingCode, startCodeTransition] = useTransition();
  const [pendingUnlink, startUnlinkTransition] = useTransition();
  const router = useRouter();

  function onGenerateCode() {
    startCodeTransition(async () => {
      const res = await generateLinkCodeAction();
      if (!res.ok || !res.code) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({
        title: "Link code generated",
        description: `Send /start ${res.code} to the bot within 15 minutes.`,
      });
      router.refresh();
    });
  }

  function onUnlink() {
    startUnlinkTransition(async () => {
      const res = await unlinkTelegramAction();
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Unlinked", description: res.message });
      router.refresh();
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("telegramAlertsEnabled", alertsEnabled ? "true" : "false");
    fd.set("telegramDailySummaryTime", dailySummaryTime);
    for (const type of TELEGRAM_ALERT_TYPES) {
      fd.set(`${type}_telegram`, "off"); // default; the checkbox sets "on"
    }
    // The form checkboxes append their own values when checked.
    startTransition(async () => {
      const res = await updateTelegramAlertsAction(fd);
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
        <Send className="size-4" aria-hidden="true" />
        Telegram alerts
      </h2>

      {/* Link status */}
      <div
        className="rounded-md border border-border p-3 space-y-2"
        data-testid="telegram-link-section"
      >
        {settings.linked ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Link2 className="size-3.5 text-profit" aria-hidden="true" />
                  Linked
                  {settings.username && (
                    <span className="text-xs text-muted-foreground">@{settings.username}</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Chat ID: {settings.chatId}
                  {settings.alertsPaused && (
                    <span className="ml-2 text-warning">· paused via /stop</span>
                  )}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onUnlink}
                disabled={pendingUnlink}
                data-testid="telegram-unlink"
              >
                <Unlink className="size-3.5 mr-1.5" aria-hidden="true" />
                Unlink
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm font-medium">Not linked</div>
            <p className="text-xs text-muted-foreground">
              Generate a one-time code, then send <code className="font-mono">/start CODE</code> to
              the RiskGuard bot in Telegram. The code expires in 15 minutes.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={onGenerateCode}
              disabled={pendingCode}
              data-testid="telegram-generate-code"
            >
              {pendingCode ? "Generating…" : "Generate link code"}
            </Button>
          </>
        )}
      </div>

      {/* Alert settings */}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="tg-enabled" className="text-sm font-medium">
              Enable Telegram alerts
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Master switch — turn off to silence all Telegram alerts (the link stays).
            </p>
          </div>
          <Switch
            id="tg-enabled"
            checked={alertsEnabled}
            onCheckedChange={(v) => setAlertsEnabled(v === true)}
            disabled={pending}
          />
        </div>

        {alertsEnabled && (
          <div className="space-y-2" data-testid="telegram-alert-toggles">
            <Label className="text-sm font-medium">Per-alert toggles</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {TELEGRAM_ALERT_TYPES.map((type) => {
                const pref = settings.prefs[type] ?? { inApp: true, email: false, telegram: true };
                const label = type
                  .split("_")
                  .map((w) => w[0] + w.slice(1).toLowerCase())
                  .join(" ");
                return (
                  <div
                    key={type}
                    className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
                  >
                    <Label htmlFor={`tg-${type}`} className="text-xs">
                      {label}
                    </Label>
                    <Switch
                      id={`tg-${type}`}
                      defaultChecked={pref.telegram !== false}
                      disabled={pending}
                      data-testid={`tg-toggle-${type}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="tg-daily-time" className="text-sm font-medium">
            Daily summary time (HH:MM, your timezone)
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
            A daily digest with your balance, P/L, and discipline score. Leave empty to skip.
          </p>
          <Input
            id="tg-daily-time"
            type="time"
            value={dailySummaryTime}
            onChange={(e) => setDailySummaryTime(e.target.value)}
            disabled={pending}
            className="w-32"
            data-testid="tg-daily-time-input"
          />
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="tg-save">
          {pending ? "Saving…" : "Save Telegram settings"}
        </Button>
      </form>
    </Card>
  );
}
