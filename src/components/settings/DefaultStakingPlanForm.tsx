"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setDefaultStakingPlanAction } from "@/server/actions/staking-plans";
import { toast } from "@/hooks/use-toast";
import { Calculator } from "lucide-react";

type Plan = { id: string; name: string; method: string; isDefault: boolean };

export function DefaultStakingPlanForm({ plans }: { plans: Plan[] }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function setDefault(planId: string) {
    const fd = new FormData();
    fd.set("planId", planId);
    startTransition(async () => {
      const res = await setDefaultStakingPlanAction(fd);
      if (res.ok) {
        toast({ title: "Default plan set", description: res.message });
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Calculator className="size-4" aria-hidden="true" />
        Default staking plan
      </h2>
      {plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No saved plans. Create one on the{" "}
          <a href="/app/stake-calculator" className="text-primary hover:underline">
            Stake Calculator
          </a>{" "}
          page.
        </p>
      ) : (
        <ul className="space-y-2">
          {plans.map((p) => (
            <li
              key={p.id}
              className={`flex items-center justify-between gap-3 p-2 rounded-md border ${
                p.isDefault ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <div>
                <span className="text-sm font-medium">{p.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{p.method}</span>
                {p.isDefault && (
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    Default
                  </Badge>
                )}
              </div>
              {!p.isDefault && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDefault(p.id)}
                >
                  Set default
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
