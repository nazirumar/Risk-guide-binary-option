"use client";

/**
 * Phase 20 — Delete-strategy button (with 2-click confirm).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteStrategyAction } from "@/server/actions/strategies";
import { toast } from "@/hooks/use-toast";

export function DeleteStrategyButton({
  strategyId,
  strategyName,
}: {
  strategyId: string;
  strategyName: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onClick() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const fd = new FormData();
    fd.set("strategyId", strategyId);
    startTransition(async () => {
      const res = await deleteStrategyAction(fd);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        setConfirming(false);
        return;
      }
      toast({ title: "Deleted", description: res.message });
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`inline-flex items-center gap-1 h-8 px-2 rounded text-xs font-medium ${
        confirming ? "bg-loss text-white hover:bg-loss/90" : "text-muted-foreground hover:bg-accent"
      }`}
      data-testid={`delete-strategy-${strategyId}`}
      aria-label={
        confirming ? `Confirm delete strategy ${strategyName}` : `Delete strategy ${strategyName}`
      }
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
      {confirming ? "Confirm" : "Delete"}
    </button>
  );
}
