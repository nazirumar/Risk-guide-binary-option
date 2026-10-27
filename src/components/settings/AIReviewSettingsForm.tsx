"use client";

/**
 * Phase 23 — AI weekly review settings card (Settings page).
 *
 * The toggle is OFF by default. The explanation makes it clear exactly
 * what data is shared (aggregated stats only — no email, name, or
 * screenshots) + that the review is descriptive, not financial advice.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateAIReviewSettingsAction } from "@/server/actions/ai-review";
import { toast } from "@/hooks/use-toast";
import { Sparkles } from "lucide-react";

export type AIReviewSettings = {
  enabled: boolean;
};

export function AIReviewSettingsForm({ defaults }: { defaults: AIReviewSettings }) {
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("aiReviewEnabled", enabled ? "true" : "false");
    startTransition(async () => {
      const res = await updateAIReviewSettingsAction(fd);
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Sparkles className="size-4" aria-hidden="true" />
        AI weekly review
      </h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="ai-review-enabled" className="text-sm font-medium">
              Enable AI weekly review
            </Label>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">
              Each week, RiskGuard sends <strong>aggregated statistics only</strong> — net P/L, win
              rate, tilt-event count, discipline score, best/worst strategy and hour, top emotions,
              rule breaches — to Anthropic&apos;s Claude to write a short plain-language review with
              3 suggestions.
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">
              <strong>Never shared:</strong> your email, name, screenshots, or individual trade
              details. If the AI service is unavailable, a rule-based summary is used instead. The
              review describes past performance — it is not financial advice and does not promise
              future results.
            </p>
          </div>
          <Switch
            id="ai-review-enabled"
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
            disabled={pending}
            data-testid="ai-review-toggle"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending} data-testid="ai-review-save">
          {pending ? "Saving…" : "Save AI review settings"}
        </Button>
      </form>
    </Card>
  );
}
