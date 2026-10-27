"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Coffee } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/trader/FormField";
import { FormError } from "@/components/auth/AuthShell";
import { manualLockoutAction } from "@/server/actions/lockout";
import { toast } from "@/hooks/use-toast";

const DURATIONS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "4 hours", value: 240 },
  { label: "1 day", value: 1440 },
];

/**
 * ManualLockoutButton — "I need a break" self-discipline action. Opens a
 * dialog where the user picks a duration + optional note, then creates a
 * MANUAL lockout that expires after the chosen time.
 */
export function ManualLockoutButton() {
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<number>(60);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const fd = new FormData();
    fd.set("durationMinutes", String(duration));
    if (reason) fd.set("reason", reason);
    startTransition(async () => {
      const res = await manualLockoutAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ title: "Manual lockout active", description: res.message });
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Coffee className="size-4 mr-2" aria-hidden="true" />I need a break
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>I need a break</DialogTitle>
          <DialogDescription>
            Self-imposed cooldown. The lockout can be overridden (with audit logging) but the
            friction makes you think twice.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label="Duration" htmlFor="duration">
            <div className="grid grid-cols-4 gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDuration(d.value)}
                  className={`h-10 rounded-md border text-sm font-medium ${
                    duration === d.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input bg-background hover:bg-accent"
                  }`}
                  disabled={pending}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </FormField>
          <FormField
            label="Reason (optional)"
            htmlFor="reason"
            hint="Why are you stepping away? Saved to your audit log."
          >
            <Textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              placeholder="Tilted after 2 losses in a row / Want to review charts / End-of-day clean-up…"
            />
          </FormField>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? "Locking…"
                : `Lock for ${duration < 60 ? `${duration}min` : `${Math.round(duration / 60)}h`}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
