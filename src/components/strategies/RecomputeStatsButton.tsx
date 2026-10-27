"use client";

/**
 * Phase 20 — Recompute-strategy-stats button (detail page).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { recomputeStrategyStatsAction } from "@/server/actions/strategies";
import { toast } from "@/hooks/use-toast";

export function RecomputeStatsButton({ strategyId }: { strategyId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onClick() {
    startTransition(async () => {
      const res = await recomputeStrategyStatsAction(strategyId);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Recomputed", description: res.message });
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-accent"
      data-testid="recompute-stats-button"
    >
      <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden="true" />
      {pending ? "Recomputing…" : "Recompute stats"}
    </button>
  );
}
