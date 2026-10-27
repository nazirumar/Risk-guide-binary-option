"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Clock, ShieldCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/trader/FormField";
import { overrideLockoutAction } from "@/server/actions/lockout";
import { toast } from "@/hooks/use-toast";

type ActiveLockout = {
  id: string;
  reason: string;
  startedAt: string;
  expiresAt: string | null;
};

const REASON_LABEL: Record<string, string> = {
  DAILY_LOSS: "Daily loss limit reached",
  CONSEC_LOSSES: "Max consecutive losses reached",
  WEEKLY_LOSS: "Weekly loss limit reached",
  MAX_TRADES: "Max trades per day reached",
  MANUAL: "Manual lockout",
};

/**
 * LockoutBanner — sticky banner shown at the top of every authed page if
 * there's an active (non-expired, non-overridden) lockout.
 *
 * The countdown timer uses `useState(0)` + `useEffect` to avoid a hydration
 * mismatch: the server renders with `now=0` (no countdown text), the client
 * also renders with `now=0` on first render (matching the server → no
 * hydration error), then the `useEffect` sets the real `Date.now()` value
 * after hydration. This is the standard React SSR pattern for time-dependent
 * values.
 */
export function LockoutBanner({ lockout }: { lockout: ActiveLockout | null }) {
  // Initialize to 0 so SSR and the first client render produce identical HTML.
  const [now, setNow] = useState(0);

  useEffect(() => {
    // Set the real timestamp after hydration. This is intentional — the
    // initial render must match the server (now=0) to avoid hydration
    // mismatch. The lint rule warns about cascading renders, but this is a
    // one-time initialization that's necessary for SSR time-dependent UI.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!lockout) return null;

  const expiry = lockout.expiresAt ? new Date(lockout.expiresAt).getTime() : null;
  // Before the client-side useEffect runs (now === 0), don't compute msLeft —
  // just show "—" until the countdown kicks in post-hydration.
  const msLeft = expiry && now > 0 ? expiry - now : null;
  if (msLeft !== null && msLeft <= 0) return null;

  const reasonLabel = REASON_LABEL[lockout.reason] ?? lockout.reason;
  const countdown = msLeft !== null ? formatCountdown(msLeft) : now === 0 ? "—" : "no expiry";

  return (
    <div
      role="alert"
      className="border-b border-warning/40 bg-warning/10 px-3 sm:px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Lock className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="font-semibold text-warning">Trading locked</span>
        <span className="text-warning-foreground/80 hidden sm:inline">·</span>
        <span className="text-warning-foreground truncate">{reasonLabel}</span>
      </div>
      <div className="flex items-center gap-3">
        {msLeft !== null ? (
          <span className="inline-flex items-center gap-1 text-warning-foreground/90 tabular-nums">
            <Clock className="size-3.5" aria-hidden="true" />
            {countdown}
          </span>
        ) : now === 0 ? (
          <span className="inline-flex items-center gap-1 text-warning-foreground/70 text-xs">
            <Clock className="size-3.5" aria-hidden="true" />
            {countdown}
          </span>
        ) : (
          <span className="text-warning-foreground/70 text-xs">No expiry — override to resume</span>
        )}
        <OverrideDialog lockoutId={lockout.id} reasonLabel={reasonLabel} />
      </div>
    </div>
  );
}

function OverrideDialog({ lockoutId, reasonLabel }: { lockoutId: string; reasonLabel: string }) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("lockoutId", lockoutId);
    fd.set("confirmationPhrase", phrase);
    fd.set("overrideReason", reason);
    startTransition(async () => {
      const res = await overrideLockoutAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      toast({ title: "Lockout overridden", description: res.message });
      setOpen(false);
      setPhrase("");
      setReason("");
      router.refresh();
    });
  }

  const canSubmit = phrase === "I understand the risk" && reason.length >= 5 && !pending;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs border-warning text-warning hover:bg-warning/15"
        >
          <ShieldCheck className="size-3 mr-1" aria-hidden="true" />
          Override
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <form onSubmit={onSubmit}>
          <AlertDialogHeader>
            <AlertDialogTitle>Override this lockout?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  You&apos;re about to override the lockout caused by <strong>{reasonLabel}</strong>
                  . This will be logged in your audit trail and shown in reports — repeated
                  overrides are a sign of a discipline problem, not a trading edge.
                </p>
                <p className="mt-2 text-xs">
                  Only override if you understand why the lockout triggered and have a plan.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-3">
            <FormField
              label="Confirmation phrase"
              htmlFor="confirmationPhrase"
              error={fieldErrors.confirmationPhrase}
              hint='Type exactly: "I understand the risk"'
            >
              <Input
                id="confirmationPhrase"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label="Reason"
              htmlFor="overrideReason"
              error={fieldErrors.overrideReason}
              hint="Why are you overriding? This will be saved to your audit trail."
            >
              <Textarea
                id="overrideReason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
                placeholder="I've reviewed my last 3 losses and have a specific plan for this trade…"
              />
            </FormField>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!canSubmit} variant="destructive">
              {pending ? "Overriding…" : "Confirm override"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return "expired";
  const sec = Math.floor(msLeft / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ${hr % 24}h ${min % 60}m`;
  if (hr > 0) return `${hr}h ${min % 60}m ${sec % 60}s`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}
