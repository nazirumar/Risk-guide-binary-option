"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/trader/FormField";
import { updateTradingHoursAction } from "@/server/actions/notifications";
import { toast } from "@/hooks/use-toast";
import { Clock } from "lucide-react";

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export function TradingHoursForm({
  defaults,
}: {
  defaults: { start: string; end: string; days: number[] } | null;
}) {
  const [start, setStart] = useState(defaults?.start ?? "09:00");
  const [end, setEnd] = useState(defaults?.end ?? "17:00");
  const [days, setDays] = useState<Set<number>>(new Set(defaults?.days ?? [1, 2, 3, 4, 5]));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function toggleDay(d: number) {
    setDays((s) => {
      const next = new Set(s);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("start", start);
    fd.set("end", end);
    for (const d of days) fd.append("days", String(d));
    startTransition(async () => {
      const res = await updateTradingHoursAction(fd);
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Clock className="size-4" aria-hidden="true" />
        Trading hours
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start time" htmlFor="start">
            <Input
              id="start"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={pending}
            />
          </FormField>
          <FormField label="End time" htmlFor="end">
            <Input
              id="end"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={pending}
            />
          </FormField>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">
            Active days
          </label>
          <div className="flex gap-2">
            {DAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                disabled={pending}
                className={`h-9 w-12 rounded-md text-xs font-medium border ${
                  days.has(d.value)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input bg-background hover:bg-accent"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <Button type="submit" disabled={pending} size="sm">
          {pending ? "Saving…" : "Save trading hours"}
        </Button>
      </form>
    </Card>
  );
}
