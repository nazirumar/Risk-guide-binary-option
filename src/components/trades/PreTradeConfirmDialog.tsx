"use client";

/**
 * Phase 17 — PreTradeConfirmDialog: the last gate before a trade is saved.
 *
 * Shows every number the trader should sanity-check (asset, direction, stake,
 * payout, potential profit/loss, stake % of balance, daily loss used,
 * trades remaining, loss streak, tilt level, plan match) — all computed
 * SERVER-SIDE at prepare time, so the modal can't lie.
 *
 * Discipline mechanics:
 *   - "Confirm trade" is disabled for N seconds with a visible countdown.
 *     The countdown mirrors the SERVER's notBefore — confirming early is
 *     rejected by the server (see createTradeAction), not just disabled here.
 *   - Optional REQUIRED "This trade follows my plan" checkbox.
 *   - Optional quick "reason for entry" (optional or required per settings).
 *   - Keyboard: Enter confirms (when enabled), Esc cancels — native Radix
 *     focus trap + explicit handlers. Fully mobile-responsive.
 *   - Cancel records a CancelledTradeAttempt ("trades you avoided").
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, formatPercent } from "@/lib/format";
import type { ConfirmationSummary } from "@/lib/calc/confirmation";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ShieldAlert, Timer } from "lucide-react";

export type PreTradeConfirmDialogProps = {
  open: boolean;
  summary: ConfirmationSummary;
  /** ISO instant before which the server rejects the save (cooldown end). */
  notBefore: string;
  /** Risk warnings (WARN severity) shown at the top of the modal. */
  warnings: string[];
  requirePlanCheckbox: boolean;
  reasonMode: "OFF" | "OPTIONAL" | "REQUIRED";
  /** Parent's transition pending — disables buttons while saving/cancelling. */
  pending: boolean;
  onConfirm: (details: { planChecked: boolean; entryReason: string }) => void;
  onCancel: (details: { planChecked: boolean; entryReason: string }) => void;
};

export function PreTradeConfirmDialog({
  open,
  summary,
  notBefore,
  warnings,
  requirePlanCheckbox,
  reasonMode,
  pending,
  onConfirm,
  onCancel,
}: PreTradeConfirmDialogProps) {
  const [planChecked, setPlanChecked] = useState(false);
  const [entryReason, setEntryReason] = useState("");
  // Initialised at mount — the parent remounts this dialog per confirmation
  // (key={token}), so the countdown always starts from the open instant.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const confirmingRef = useRef(false);

  // Countdown — ticks against the SERVER-provided notBefore (not a client
  // timer started at open), so clock skew between prepare + render is safe.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = useMemo(
    () => Math.max(0, Math.ceil((new Date(notBefore).getTime() - nowMs) / 1000)),
    [notBefore, nowMs],
  );

  const reasonMissing = reasonMode === "REQUIRED" && entryReason.trim().length === 0;
  const planMissing = requirePlanCheckbox && !planChecked;
  const canConfirm = secondsLeft === 0 && !reasonMissing && !planMissing && !pending;

  function doConfirm() {
    if (confirmingRef.current || !canConfirm) return;
    confirmingRef.current = true;
    onConfirm({ planChecked, entryReason });
  }

  function doCancel() {
    if (pending) return;
    onCancel({ planChecked, entryReason });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey) return;
    // Buttons handle Enter natively (click); the reason textarea must allow
    // newlines. Everything else — Enter confirms when enabled.
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "BUTTON") return;
    e.preventDefault();
    if (canConfirm) doConfirm();
  }

  const currency = summary.currency;
  const lossPct =
    summary.dailyLossUsedPercent !== null ? Number(summary.dailyLossUsedPercent) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Esc / overlay click / close button all route through cancel so the
        // attempt is recorded. Suppress while a save is in flight.
        if (!o && !pending) doCancel();
        else if (!o && pending) return; // keep open during save
      }}
    >
      <DialogContent
        className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto"
        onKeyDown={onKeyDown}
        data-testid="pre-trade-dialog"
        role="alertdialog"
        aria-describedby="pre-trade-summary"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-5 text-primary" aria-hidden="true" />
            Confirm your trade
          </DialogTitle>
          <DialogDescription className="text-xs">
            Check every number before confirming. This pause is the discipline.
          </DialogDescription>
        </DialogHeader>

        {/* Risk warnings (WARN severity from the risk engine) */}
        {warnings.length > 0 && (
          <div
            className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning"
            role="alert"
          >
            {warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}

        {/* Summary grid — the live numbers */}
        <div
          id="pre-trade-summary"
          className="rounded-md border border-border bg-muted/30 p-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm"
        >
          <SummaryRow label="Asset">
            <span className="font-mono font-semibold">{summary.asset}</span>
            <span
              className={cn(
                "ml-1.5 text-xs font-bold px-1.5 py-0.5 rounded",
                summary.direction === "CALL" ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss",
              )}
            >
              {summary.direction}
            </span>
          </SummaryRow>

          <SummaryRow label="Stake">
            <span className="font-semibold tabular-nums">
              {formatMoney(summary.stake, currency)}
            </span>
          </SummaryRow>

          <SummaryRow label="Payout">
            <span className="tabular-nums">
              {formatPercent(Number(summary.payoutPercent), { alreadyPercent: false, decimals: 0 })}
            </span>
          </SummaryRow>

          <SummaryRow label="Expiry">
            <span className="tabular-nums">{summary.expiryMinutes} min</span>
          </SummaryRow>

          <SummaryRow label="Potential profit">
            <span className="text-profit font-semibold tabular-nums">
              +{formatMoney(summary.potentialProfit, currency)}
            </span>
          </SummaryRow>

          <SummaryRow label="Potential loss">
            <span className="text-loss font-semibold tabular-nums">
              {formatMoney(summary.potentialLoss, currency)}
            </span>
          </SummaryRow>

          <SummaryRow label="Stake % of balance">
            <span
              className={cn(
                "font-semibold tabular-nums",
                Number(summary.stakePercentOfBalance) > 0.05
                  ? "text-loss"
                  : Number(summary.stakePercentOfBalance) > 0.02
                    ? "text-warning"
                    : "text-profit",
              )}
            >
              {formatPercent(Number(summary.stakePercentOfBalance), {
                alreadyPercent: false,
                decimals: 2,
              })}
            </span>
          </SummaryRow>

          <SummaryRow label="Daily loss used">
            {lossPct === null ? (
              <span className="text-xs text-muted-foreground">No limit set</span>
            ) : (
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  lossPct >= 1 ? "text-loss" : lossPct >= 0.8 ? "text-warning" : "text-foreground",
                )}
              >
                {formatPercent(lossPct, { alreadyPercent: false, decimals: 0 })}
                {lossPct >= 1 && <span className="text-loss text-xs"> · over limit</span>}
              </span>
            )}
          </SummaryRow>

          <SummaryRow label="Trades remaining today">
            <span className="tabular-nums">
              {summary.tradesRemainingToday} of {summary.maxTradesPerDay}
            </span>
          </SummaryRow>

          <SummaryRow label="Loss streak">
            <span
              className={cn(
                "tabular-nums font-semibold",
                summary.currentLossStreak >= 2 ? "text-warning" : "text-foreground",
              )}
            >
              {summary.currentLossStreak === 0 ? "None" : `${summary.currentLossStreak} in a row`}
            </span>
          </SummaryRow>

          <SummaryRow label="Tilt level">
            <span
              className={cn(
                "font-semibold",
                summary.tiltLevel === "TILT"
                  ? "text-loss"
                  : summary.tiltLevel === "CAUTION"
                    ? "text-warning"
                    : "text-profit",
              )}
            >
              {summary.tiltLevel}
              {summary.tiltLevel !== "CALM" && (
                <span className="text-xs text-muted-foreground"> ({summary.tiltScore}/100)</span>
              )}
            </span>
          </SummaryRow>

          <SummaryRow label="Staking plan">
            {!summary.plan.hasPlan ? (
              <span className="text-xs text-muted-foreground">No plan set</span>
            ) : summary.plan.matches ? (
              <span className="flex items-center gap-1 text-profit text-xs font-medium">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                Matches plan ({formatMoney(summary.plan.suggestedStake ?? "0", currency)})
              </span>
            ) : (
              <span className="text-warning text-xs font-medium">
                Off plan: {formatMoney(summary.plan.deviation ?? "0", currency, { signed: true })}{" "}
                vs suggestion {formatMoney(summary.plan.suggestedStake ?? "0", currency)}
              </span>
            )}
          </SummaryRow>
        </div>

        {/* Required plan checkbox */}
        {requirePlanCheckbox && (
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="pre-trade-plan"
              checked={planChecked}
              onCheckedChange={(v) => setPlanChecked(v === true)}
              disabled={pending}
              className="mt-0.5"
              data-testid="pre-trade-plan-checkbox"
            />
            <Label htmlFor="pre-trade-plan" className="text-sm leading-snug cursor-pointer">
              This trade follows my plan <span className="text-loss">*</span>
            </Label>
          </div>
        )}

        {/* Reason for entry */}
        {reasonMode !== "OFF" && (
          <div className="space-y-1.5">
            <Label htmlFor="pre-trade-reason" className="text-sm">
              Reason for entry{" "}
              {reasonMode === "REQUIRED" ? (
                <span className="text-loss">*</span>
              ) : (
                <span className="text-muted-foreground">(optional)</span>
              )}
            </Label>
            <Input
              id="pre-trade-reason"
              type="text"
              maxLength={500}
              value={entryReason}
              onChange={(e) => setEntryReason(e.target.value)}
              disabled={pending}
              placeholder="e.g. London open retest, 2nd touch of level…"
              data-testid="pre-trade-reason"
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={doCancel}
            disabled={pending}
            data-testid="pre-trade-cancel"
          >
            Cancel trade
          </Button>
          <Button
            type="button"
            onClick={doConfirm}
            disabled={!canConfirm}
            data-testid="pre-trade-confirm"
            className="min-w-[190px]"
            aria-disabled={!canConfirm}
          >
            {secondsLeft > 0 ? (
              <span
                className="flex items-center gap-1.5 tabular-nums"
                data-testid="pre-trade-countdown"
              >
                <Timer className="size-4 animate-pulse" aria-hidden="true" />
                Confirm trade ({secondsLeft}s)
              </span>
            ) : planMissing ? (
              "Check the plan box to confirm"
            ) : reasonMissing ? (
              "Add your reason to confirm"
            ) : pending ? (
              "Saving…"
            ) : (
              "Confirm trade"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
