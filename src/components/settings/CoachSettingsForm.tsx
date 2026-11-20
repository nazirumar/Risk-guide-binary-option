"use client";

/**
 * Phase 30.2 — AI journal coach settings card.
 *
 * Both toggles are OFF by default. The copy states exactly what is shared so
 * the opt-in is informed: aggregates from the user's own journal, plus their
 * own notes only if the second toggle is explicitly enabled.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateCoachSettingsAction } from "@/server/actions/coach";
import { toast } from "@/hooks/use-toast";
import { MessageCircle } from "lucide-react";

export type CoachSettingsDefaults = {
  enabled: boolean;
  includeNotes: boolean;
};

export function CoachSettingsForm({ defaults }: { defaults: CoachSettingsDefaults }) {
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [includeNotes, setIncludeNotes] = useState(defaults.includeNotes);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("aiCoachEnabled", enabled ? "true" : "false");
    fd.set("coachIncludeNotes", includeNotes ? "true" : "false");
    startTransition(async () => {
      const res = await updateCoachSettingsAction(fd);
      if (res.ok) {
        toast({ title: "Saved", description: res.message });
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4" data-testid="coach-settings-card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <MessageCircle className="size-4" aria-hidden="true" />
        AI journal coach
      </h2>
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="coach-enabled" className="text-sm font-medium">
              Enable AI journal coach
            </Label>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">
              An opt-in chat on the Reports page that reflects on <strong>your own</strong> journal
              and answers questions about your habits. It shares aggregated numbers from the last 30
              days — trade counts, win rate, net P/L, discipline score, tilt events, rule breaches
              and plan-following rate.
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">
              <strong>Never shared:</strong> your email, name, screenshots, or any other user&apos;s
              data. The coach focuses on process and discipline — it is not financial advice and
              makes no profit promises. A disclaimer is appended to every reply.
            </p>
          </div>
          <Switch
            id="coach-enabled"
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
            disabled={pending}
            data-testid="coach-enabled-toggle"
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
          <div>
            <Label htmlFor="coach-include-notes" className="text-sm font-medium">
              Also include my own journal notes
            </Label>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">
              Separate opt-in. When on, the coach may also read your own daily reflections, session
              notes and trade setup notes from the last 30 days. Leave off to share aggregates only.
              Notes are treated as untrusted text and cannot override the coach&apos;s safety rules.
            </p>
          </div>
          <Switch
            id="coach-include-notes"
            checked={includeNotes}
            onCheckedChange={(v) => setIncludeNotes(v === true)}
            disabled={pending}
            data-testid="coach-notes-toggle"
          />
        </div>

        <Button type="submit" size="sm" disabled={pending} data-testid="coach-settings-save">
          {pending ? "Saving…" : "Save coach settings"}
        </Button>
      </form>
    </Card>
  );
}
