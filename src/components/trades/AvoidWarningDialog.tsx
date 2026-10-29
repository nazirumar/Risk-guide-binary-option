"use client";

/**
 * Phase 29 — AVOID warning confirmation dialog (Add Trade flow).
 *
 * Opens when the trader presses Save and the server reports the pair is
 * rated AVOID (and the warning applies for this account). The copy states
 * WHAT the conditions are ("Conditions look unfavorable: high-impact news in
 * 8 minutes.") — no prediction, no signal language (rule #11).
 *
 * The warning is advisory by design: "Continue anyway" proceeds with the
 * save and marks the trade `ignoredAvoidWarning` (which the discipline score
 * counts); "Cancel" records a CancelledTradeAttempt like every other cancel.
 * Non-blocking — the trader always keeps the final call.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export type AvoidWarningDialogState = {
  headline: string;
  reasons: string[];
  ratingScore: number | null;
};

export function AvoidWarningDialog({
  state,
  pending,
  onContinue,
  onCancel,
}: {
  state: AvoidWarningDialogState | null;
  pending: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={state != null}
      onOpenChange={(o) => {
        if (!o && !pending) onCancel();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md"
        role="alertdialog"
        aria-describedby="avoid-warning-desc"
        data-testid="avoid-warning-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-loss">
            <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
            Market conditions look unfavorable
          </DialogTitle>
          <DialogDescription id="avoid-warning-desc" className="text-xs">
            {state?.headline ?? "This pair is rated AVOID right now."}
          </DialogDescription>
        </DialogHeader>

        {state && state.reasons.length > 0 && (
          <ul className="space-y-1 rounded-md border border-loss/40 bg-loss/10 p-2.5 text-xs text-loss">
            {state.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{r}</span>
              </li>
            ))}
            {state.ratingScore != null && (
              <li className="opacity-80">Market score: {state.ratingScore}/100.</li>
            )}
          </ul>
        )}

        <p className="text-[11px] text-muted-foreground">
          You can still take the trade — the rating describes current conditions, not the outcome.
          If you continue, the choice is logged and counts toward your daily discipline score.
          Past results don&apos;t guarantee future results.
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
            data-testid="avoid-warning-cancel"
          >
            Cancel trade
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onContinue}
            disabled={pending}
            data-testid="avoid-warning-continue"
          >
            Continue anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
