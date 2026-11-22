"use client";

/**
 * Optional schedule for the Phase 30.4 news briefing. All channels remain OFF
 * by default in NotificationPrefsForm; this card only controls WHEN a digest
 * is sent once the user has opted in.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { BRIEFING_FREQUENCIES, normalizeBriefingSchedule } from "@/lib/news/schedule";
import { updateBriefingScheduleAction } from "@/server/actions/notifications";

type Props = {
  defaults: {
    briefingTime?: string;
    briefingFrequency?: string;
    briefingWeekday?: number;
  } | null;
  timezone: string;
  optedIn: boolean;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function BriefingScheduleForm({ defaults, timezone, optedIn }: Props) {
  const schedule = normalizeBriefingSchedule(defaults ?? undefined);
  const [time, setTime] = useState(schedule.briefingTime);
  const [frequency, setFrequency] = useState<string>(schedule.briefingFrequency);
  const [weekday, setWeekday] = useState(String(schedule.briefingWeekday));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await updateBriefingScheduleAction({
        briefingTime: time,
        briefingFrequency: frequency,
        briefingWeekday: Number(weekday),
      });
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      } else {
        toast({ title: "Could not save", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Clock3 className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          News briefing schedule
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are in your account timezone ({timezone || "UTC"}). The cron runs every 15 minutes; a
        chosen 08:30 digest is sent in the 08:30–08:45 window.{" "}
        {optedIn
          ? "Change the channels above to stop receiving it."
          : "Turn on at least one News briefing channel above to receive it."}
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="briefing-time">Time</Label>
          <Input
            id="briefing-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={pending}
            data-testid="briefing-time"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="briefing-frequency">Frequency</Label>
          <select
            id="briefing-frequency"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            disabled={pending}
            data-testid="briefing-frequency"
          >
            {BRIEFING_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f === "WEEKDAYS" ? "Weekdays" : f === "WEEKLY" ? "Weekly" : "Daily"}
              </option>
            ))}
          </select>
        </div>
        {frequency === "WEEKLY" && (
          <div className="space-y-1">
            <Label htmlFor="briefing-weekday">Day</Label>
            <select
              id="briefing-weekday"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
              disabled={pending}
              data-testid="briefing-weekday"
            >
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button type="submit" size="sm" disabled={pending} data-testid="briefing-schedule-save">
          {pending ? "Saving…" : "Save schedule"}
        </Button>
      </form>
    </Card>
  );
}
