"use client";

/**
 * Phase 19 — Delete-rule button.
 *
 * Wraps deleteWithdrawalRuleAction in a small inline button with a confirm
 * step (click → "Confirm delete?" → second click deletes). Uses toast +
 * router.refresh() on success.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteWithdrawalRuleAction } from "@/server/actions/withdrawals";
import { toast } from "@/hooks/use-toast";

export function DeleteRuleButton({ ruleId }: { ruleId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onClick() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const fd = new FormData();
    fd.set("ruleId", ruleId);
    startTransition(async () => {
      const res = await deleteWithdrawalRuleAction(fd);
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
      data-testid={`delete-rule-${ruleId}`}
      aria-label={confirming ? "Confirm delete rule" : "Delete rule"}
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
      {confirming ? "Confirm" : "Delete"}
    </button>
  );
}
