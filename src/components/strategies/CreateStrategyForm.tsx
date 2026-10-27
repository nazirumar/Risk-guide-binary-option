"use client";

/**
 * Phase 20 — Strategy create form (used in the strategies list page).
 * Allows the user to add a new strategy (name, description, color).
 * Calls createStrategyAction on submit.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createStrategyAction } from "@/server/actions/strategies";
import { toast } from "@/hooks/use-toast";

export function CreateStrategyForm() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#64748b");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("name", name);
    fd.set("description", description);
    fd.set("color", color);
    startTransition(async () => {
      const res = await createStrategyAction(fd);
      if (!res.ok) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      toast({ title: "Created", description: res.message });
      setName("");
      setDescription("");
      setColor("#64748b");
      router.refresh();
    });
  }

  return (
    <Card className="p-5 space-y-4" data-testid="create-strategy-form">
      <h3 className="text-sm font-semibold">New strategy</h3>
      <p className="text-xs text-muted-foreground">
        A strategy is a label you attach to trades — anything from a setup name to a market regime.
        Stats are computed from the trades linked to each strategy.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="strat-name" className="text-sm font-medium">
            Name
          </Label>
          <Input
            id="strat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="e.g. Trend-following EUR/USD"
            maxLength={100}
            className="mt-1"
            data-testid="strat-name-input"
          />
        </div>
        <div>
          <Label htmlFor="strat-desc" className="text-sm font-medium">
            Description (optional)
          </Label>
          <Textarea
            id="strat-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
            placeholder="What's the setup? When do you trade it?"
            rows={2}
            className="mt-1"
            data-testid="strat-desc-input"
          />
        </div>
        <div>
          <Label htmlFor="strat-color" className="text-sm font-medium">
            Color
          </Label>
          <input
            id="strat-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={pending}
            className="mt-1 h-9 w-16 rounded border border-input bg-background"
            data-testid="strat-color-input"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending || !name.trim()} data-testid="strat-save">
          {pending ? "Saving…" : "Create strategy"}
        </Button>
      </form>
    </Card>
  );
}
