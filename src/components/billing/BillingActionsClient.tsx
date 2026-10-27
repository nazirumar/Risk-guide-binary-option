"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  createCheckoutAction,
  cancelSubscriptionAction,
  resumeSubscriptionAction,
} from "@/server/actions/billing";
import { toast } from "@/hooks/use-toast";
import { Crown, X, Play } from "lucide-react";
import type { PlanKey } from "@/lib/billing/plans";

export function BillingActionsClient({
  plan,
  status,
  cancelAtPeriodEnd,
}: {
  plan: PlanKey;
  status: string;
  cancelAtPeriodEnd: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onUpgrade() {
    startTransition(async () => {
      const res = await createCheckoutAction();
      if (res.ok && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  function onCancel() {
    startTransition(async () => {
      const res = await cancelSubscriptionAction();
      toast({
        title: res.ok ? "Cancelled" : "Failed",
        description: res.message,
        variant: res.ok ? "default" : "destructive",
      });
      if (res.ok) router.refresh();
    });
  }

  function onResume() {
    startTransition(async () => {
      const res = await resumeSubscriptionAction();
      toast({
        title: res.ok ? "Resumed" : "Failed",
        description: res.message,
        variant: res.ok ? "default" : "destructive",
      });
      if (res.ok) router.refresh();
    });
  }

  if (plan === "FREE") {
    return (
      <Button size="sm" onClick={onUpgrade} disabled={pending} data-testid="upgrade-button">
        <Crown className="size-4 mr-1.5" aria-hidden="true" />
        {pending ? "Initializing…" : "Upgrade to Pro"}
      </Button>
    );
  }

  return (
    <div className="flex gap-2">
      {cancelAtPeriodEnd ? (
        <Button
          size="sm"
          variant="default"
          onClick={onResume}
          disabled={pending}
          data-testid="resume-button"
        >
          <Play className="size-4 mr-1.5" aria-hidden="true" />
          {pending ? "Resuming…" : "Resume subscription"}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
          data-testid="cancel-button"
        >
          <X className="size-4 mr-1.5" aria-hidden="true" />
          {pending ? "Cancelling…" : "Cancel at period end"}
        </Button>
      )}
    </div>
  );
}
