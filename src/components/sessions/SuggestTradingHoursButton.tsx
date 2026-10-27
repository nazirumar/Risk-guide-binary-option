"use client";

/**
 * Phase 22 — Suggest trading hours button (calls suggestTradingHoursAction
 * on click + shows the result inline).
 *
 * The button pre-fills the trading-hours setting via `updateTradingHoursAction`
 * (Phase 12) when the user accepts the suggestion.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wand2 } from "lucide-react";
import { suggestTradingHoursAction } from "@/server/actions/market-sessions";
import { updateTradingHoursAction } from "@/server/actions/notifications";
import { toast } from "@/hooks/use-toast";

type Suggestion = { start: string; end: string; days: number[] } | null;

export function SuggestTradingHoursButton({
  initialSuggestion,
}: {
  initialSuggestion: Suggestion;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion>(initialSuggestion);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSuggest() {
    startTransition(async () => {
      const res = await suggestTradingHoursAction();
      if (!res.ok) {
        toast({ title: "Couldn't suggest", description: res.message, variant: "destructive" });
        return;
      }
      setSuggestion(res.suggestion ?? null);
      toast({ title: "Suggestion ready", description: res.message });
    });
  }

  function onApply() {
    if (!suggestion) return;
    const fd = new FormData();
    fd.set("start", suggestion.start);
    fd.set("end", suggestion.end);
    for (const d of suggestion.days) fd.append("days", String(d));
    startTransition(async () => {
      const res = await updateTradingHoursAction(fd);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({
        title: "Saved",
        description: `Trading hours set to ${suggestion.start}–${suggestion.end} Mon–Fri.`,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={onSuggest}
        disabled={pending}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-accent"
        data-testid="suggest-trading-hours"
      >
        <Wand2 className="size-3.5" aria-hidden="true" />
        {pending ? "Suggesting…" : "Suggest trading hours"}
      </button>
      {suggestion && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="suggested-window">
            Suggested: {suggestion.start}–{suggestion.end} Mon–Fri
          </span>
          <button
            type="button"
            onClick={onApply}
            disabled={pending}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
            data-testid="apply-suggested-hours"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
