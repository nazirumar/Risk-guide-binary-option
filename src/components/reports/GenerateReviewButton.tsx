"use client";

/**
 * Phase 23 — Generate-weekly-review button (Reports page).
 * Calls generateWeeklyReviewAction for the current week.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { generateWeeklyReviewAction } from "@/server/actions/ai-review";
import { toast } from "@/hooks/use-toast";

export function GenerateReviewButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onClick() {
    startTransition(async () => {
      const res = await generateWeeklyReviewAction();
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Review generated", description: res.message });
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-accent"
      data-testid="generate-review-button"
    >
      <Sparkles className={`size-3.5 ${pending ? "animate-pulse" : ""}`} aria-hidden="true" />
      {pending ? "Generating…" : "Generate now"}
    </button>
  );
}
