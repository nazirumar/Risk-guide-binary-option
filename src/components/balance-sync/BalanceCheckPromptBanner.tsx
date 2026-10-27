"use client";

/**
 * Phase 18 — Dashboard banner that prompts the trader to verify their broker
 * balance against the app's books on the configured cadence (DAILY / WEEKLY /
 * OFF). When the user opens the dialog (or dismisses it), the action's
 * `markBalanceCheckPromptedAction` stamps `balanceSyncLastPromptedAt = now`
 * so the same session doesn't re-prompt.
 *
 * Hydration-safe: the banner is hidden on the server render (no flash) and
 * surfaces only after the client fetches the should-prompt decision. This
 * matches the Phase 16 LockoutBanner pattern.
 */
import { useEffect, useState, useTransition } from "react";
import { RefreshCw, X } from "lucide-react";
import { BalanceCheckDialog } from "./BalanceCheckDialog";
import {
  shouldPromptBalanceCheckAction,
  markBalanceCheckPromptedAction,
} from "@/server/actions/balance-sync";

type PromptState = {
  loading: boolean;
  shouldPrompt: boolean;
  tradingAccountId: string | null;
  accountName: string;
};

export function BalanceCheckPromptBanner({
  activeAccount,
}: {
  activeAccount: {
    id: string;
    name: string;
    currency: string;
    currentBalance: string;
  } | null;
}) {
  const [state, setState] = useState<PromptState>({
    loading: true,
    shouldPrompt: false,
    tradingAccountId: null,
    accountName: "",
  });
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      const res = await shouldPromptBalanceCheckAction();
      if (cancelled) return;
      setState({
        loading: false,
        shouldPrompt: !!res.shouldPrompt,
        tradingAccountId: res.tradingAccountId ?? null,
        accountName: res.accountName ?? "",
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Don't render anything if there's no active account, no prompt needed,
  // or the user dismissed the banner in this session.
  if (
    !activeAccount ||
    state.loading ||
    !state.shouldPrompt ||
    dismissed ||
    state.tradingAccountId !== activeAccount.id
  ) {
    return null;
  }

  function onDismiss() {
    setDismissed(true);
    startTransition(async () => {
      await markBalanceCheckPromptedAction();
    });
  }

  function onOpenChange(open: boolean) {
    if (!open) {
      // The dialog either confirmed or cancelled — either way, mark the
      // reminder as shown so it doesn't pop again this session.
      setDismissed(true);
      startTransition(async () => {
        await markBalanceCheckPromptedAction();
      });
    }
  }

  return (
    <BalanceCheckDialog account={activeAccount} triggerVariant="banner" onOpenChange={onOpenChange}>
      <div
        className="rounded-lg border border-info/30 bg-info/5 px-4 py-3 flex items-center justify-between gap-4"
        data-testid="balance-check-prompt"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="rounded-full bg-info/15 p-2 shrink-0">
            <RefreshCw className="size-5 text-info" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Time to verify your broker balance</h2>
            <p className="text-xs text-muted-foreground">
              Enter the real balance for {activeAccount.name} and confirm our books match. Daily
              check keeps your accuracy score healthy.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground p-1 rounded"
            aria-label="Dismiss reminder"
            data-testid="balance-check-prompt-dismiss"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-info text-info-foreground text-xs font-medium hover:bg-info/90"
            data-testid="balance-check-prompt-open"
            disabled={pending}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Check now
          </button>
        </div>
      </div>
    </BalanceCheckDialog>
  );
}
