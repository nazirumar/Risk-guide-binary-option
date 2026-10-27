"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X, Minus } from "lucide-react";
import { closeTradeAction } from "@/server/actions/trades";
import { toast } from "@/hooks/use-toast";

/**
 * CloseTradeButtons — three quick-close buttons on OPEN trades:
 *   WIN   (green check)   — profitLoss = +stake * payout
 *   LOSS  (red X)         — profitLoss = -stake
 *   TIE   (gray minus)    — profitLoss = 0
 *
 * Server action runs the atomic recompute (balanceAfter + currentBalance).
 */
export function CloseTradeButtons({ tradeId, asset }: { tradeId: string; asset: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function close(result: "WIN" | "LOSS" | "TIE") {
    const fd = new FormData();
    fd.set("tradeId", tradeId);
    fd.set("result", result);
    startTransition(async () => {
      const res = await closeTradeAction(fd);
      if (res.ok) {
        toast({ title: `Closed as ${result}`, description: res.message });
        router.refresh();
      } else {
        toast({ title: "Failed to close", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <div
      className="inline-flex gap-0.5 rounded-md border border-border p-0.5"
      role="group"
      aria-label={`Quick-close ${asset}`}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 text-profit hover:bg-profit/15 hover:text-profit"
        onClick={() => close("WIN")}
        disabled={pending}
        aria-label={`Close ${asset} as WIN`}
        title="WIN"
      >
        <Check className="size-3" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 text-loss hover:bg-loss/15 hover:text-loss"
        onClick={() => close("LOSS")}
        disabled={pending}
        aria-label={`Close ${asset} as LOSS`}
        title="LOSS"
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
        onClick={() => close("TIE")}
        disabled={pending}
        aria-label={`Close ${asset} as TIE`}
        title="TIE"
      >
        <Minus className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
