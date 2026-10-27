"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { updateNotificationPrefsAction } from "@/server/actions/notifications";
import { DEFAULT_PREFS } from "@/server/lib/notification-types";
import { toast } from "@/hooks/use-toast";
import { Bell, Mail } from "lucide-react";

const NOTIFICATION_TYPES = [
  {
    key: "RISK_LIMIT_80",
    label: "Approaching daily loss limit (80%)",
    description: "You've used 80% of your daily loss cap.",
  },
  {
    key: "RISK_LIMIT_100",
    label: "Daily loss limit reached (100%)",
    description: "Lockout auto-triggered.",
  },
  {
    key: "LOCKOUT_STARTED",
    label: "Lockout started",
    description: "Any auto or manual lockout begins.",
  },
  {
    key: "LOCKOUT_ENDED",
    label: "Lockout ended",
    description: "A lockout expired or was overridden.",
  },
  {
    key: "GOAL_ACHIEVED",
    label: "Goal achieved",
    description: "You hit a daily/weekly/monthly target.",
  },
  { key: "WEEKLY_SUMMARY", label: "Weekly summary", description: "End-of-week P/L digest." },
  { key: "INACTIVITY", label: "Inactivity reminder", description: "No trades in 3+ days." },
];

export function NotificationPrefsForm({
  prefs,
}: {
  prefs: Record<string, { inApp: boolean; email: boolean }> | null;
}) {
  const merged = { ...DEFAULT_PREFS, ...(prefs ?? {}) };
  const [form, setForm] = useState(merged);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function set(key: string, channel: "inApp" | "email", value: boolean) {
    setForm((f) => ({ ...f, [key]: { ...f[key], [channel]: value } }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    for (const [type, pref] of Object.entries(form)) {
      if (pref.inApp) fd.append(`${type}_inApp`, "on");
      if (pref.email) fd.append(`${type}_email`, "on");
    }
    startTransition(async () => {
      const res = await updateNotificationPrefsAction(fd);
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Notification preferences
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-2 items-center text-xs">
          <span className="font-medium text-muted-foreground">Alert type</span>
          <span className="font-medium text-muted-foreground flex items-center gap-1">
            <Bell className="size-3" /> In-app
          </span>
          <span className="font-medium text-muted-foreground flex items-center gap-1">
            <Mail className="size-3" /> Email
          </span>
          {NOTIFICATION_TYPES.map((t) => (
            <NotificationRow
              key={t.key}
              type={t}
              pref={form[t.key] ?? { inApp: true, email: false }}
              onToggle={(channel, value) => set(t.key, channel, value)}
              disabled={pending}
            />
          ))}
        </div>
        <Button type="submit" disabled={pending} size="sm">
          {pending ? "Saving…" : "Save preferences"}
        </Button>
      </form>
    </Card>
  );
}

function NotificationRow({
  type,
  pref,
  onToggle,
  disabled,
}: {
  type: { key: string; label: string; description: string };
  pref: { inApp: boolean; email: boolean };
  onToggle: (channel: "inApp" | "email", value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div>
        <div className="text-sm font-medium">{type.label}</div>
        <div className="text-xs text-muted-foreground">{type.description}</div>
      </div>
      <Switch
        checked={pref.inApp}
        onCheckedChange={(v) => onToggle("inApp", v === true)}
        disabled={disabled}
      />
      <Switch
        checked={pref.email}
        onCheckedChange={(v) => onToggle("email", v === true)}
        disabled={disabled}
      />
    </>
  );
}
