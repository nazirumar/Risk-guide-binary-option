"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/trader/FormField";
import { AssetCombobox } from "./AssetCombobox";
import { updateTradeAction } from "@/server/actions/trades";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { TradeRow } from "./TradesTable";

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const EMOTIONS = ["CALM", "CONFIDENT", "FEARFUL", "GREEDY", "REVENGE", "TIRED", "BORED"];

/**
 * TradeEditDialog — inline-edit form for a trade. Edits any field; if the
 * trade is closed and the stake/payout/result changed, the realized P/L is
 * recomputed and the balanceAfter equity walk re-walked.
 */
export function TradeEditDialog({
  trade,
  strategies,
  onClose,
}: {
  trade: TradeRow;
  strategies: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    asset: trade.asset,
    direction: trade.direction,
    stake: trade.stake,
    payoutPercent: trade.payoutPercent,
    expiryMinutes: String(trade.expiryMinutes),
    strategyId: strategies.find((s) => s.name === trade.strategyName)?.id ?? "",
    timeframe: trade.timeframe ?? "",
    emotion: trade.emotion ?? "",
    followedPlan: trade.followedPlan,
    setupNotes: trade.notes ?? "",
    tags: trade.tags.join(", "),
    result: trade.result,
  });
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("tradeId", trade.id);
    fd.set("asset", form.asset);
    fd.set("direction", form.direction);
    fd.set("stake", form.stake);
    fd.set("payoutPercent", form.payoutPercent);
    fd.set("expiryMinutes", form.expiryMinutes);
    if (form.strategyId) fd.set("strategyId", form.strategyId);
    if (form.timeframe) fd.set("timeframe", form.timeframe);
    if (form.emotion) fd.set("emotion", form.emotion);
    fd.set("followedPlan", form.followedPlan ? "true" : "false");
    if (form.setupNotes) fd.set("setupNotes", form.setupNotes);
    fd.set("result", form.result);
    // tags: comma-separated → multiple form entries
    for (const t of form.tags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      fd.append("tags", t);
    }
    startTransition(async () => {
      const res = await updateTradeAction(fd);
      if (res.ok) {
        toast({ title: "Trade updated", description: res.message });
        onClose();
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit trade</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Asset" htmlFor="asset" required>
              <AssetCombobox
                value={form.asset}
                onChange={(v) => set("asset", v)}
                disabled={pending}
              />
            </FormField>
            <FormField label="Direction" htmlFor="direction" required>
              <div className="grid grid-cols-2 gap-1.5">
                {(["CALL", "PUT"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set("direction", d)}
                    className={cn(
                      "h-11 rounded-md border px-3 text-sm font-bold",
                      form.direction === d
                        ? d === "CALL"
                          ? "border-profit bg-profit/15 text-profit"
                          : "border-loss bg-loss/15 text-loss"
                        : "border-input bg-background hover:bg-accent",
                    )}
                    disabled={pending}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FormField label="Stake" htmlFor="stake" required>
              <Input
                id="stake"
                type="number"
                step="0.01"
                value={form.stake}
                onChange={(e) => set("stake", e.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField label="Payout %" htmlFor="payoutPercent" required>
              <Input
                id="payoutPercent"
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={form.payoutPercent}
                onChange={(e) => set("payoutPercent", e.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField label="Expiry (min)" htmlFor="expiryMinutes" required>
              <Input
                id="expiryMinutes"
                type="number"
                step="1"
                value={form.expiryMinutes}
                onChange={(e) => set("expiryMinutes", e.target.value)}
                disabled={pending}
              />
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FormField label="Strategy" htmlFor="strategyId">
              <select
                id="strategyId"
                value={form.strategyId}
                onChange={(e) => set("strategyId", e.target.value)}
                disabled={pending}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— none —</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Timeframe" htmlFor="timeframe">
              <select
                id="timeframe"
                value={form.timeframe}
                onChange={(e) => set("timeframe", e.target.value)}
                disabled={pending}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— none —</option>
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Emotion" htmlFor="emotion">
              <select
                id="emotion"
                value={form.emotion}
                onChange={(e) => set("emotion", e.target.value)}
                disabled={pending}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— none —</option>
                {EMOTIONS.map((e) => (
                  <option key={e} value={e}>
                    {e.charAt(0) + e.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Result" htmlFor="result">
              <select
                id="result"
                value={form.result}
                onChange={(e) => set("result", e.target.value as typeof form.result)}
                disabled={pending}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="OPEN">OPEN (still running)</option>
                <option value="WIN">WIN</option>
                <option value="LOSS">LOSS</option>
                <option value="TIE">TIE</option>
              </select>
            </FormField>
            <div className="flex items-end gap-3 pb-1">
              <Switch
                id="followedPlan"
                checked={form.followedPlan}
                onCheckedChange={(v) => set("followedPlan", v === true)}
                disabled={pending}
              />
              <Label
                htmlFor="followedPlan"
                className="text-sm font-medium leading-none cursor-pointer"
              >
                Followed plan
              </Label>
            </div>
          </div>
          <FormField label="Setup notes" htmlFor="setupNotes">
            <Textarea
              id="setupNotes"
              rows={3}
              value={form.setupNotes}
              onChange={(e) => set("setupNotes", e.target.value)}
              disabled={pending}
            />
          </FormField>
          <FormField label="Tags (comma-separated)" htmlFor="tags">
            <Input
              id="tags"
              value={form.tags}
              onChange={(e) => set("tags", e.target.value)}
              disabled={pending}
            />
          </FormField>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
