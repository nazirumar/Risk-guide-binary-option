"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AddTradeForm } from "./AddTradeForm";
import Decimal from "decimal.js";

type AccountLite = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: "DEMO" | "REAL";
  currentBalance: Decimal | string;
};

type StrategyLite = { id: string; name: string };

type NextStakeSuggestion = {
  suggestedStake: string;
  planName: string;
  clamped: boolean;
};

/**
 * AddTradeDialog — opens the AddTradeForm in a modal. Used on the trades
 * page header for quick add (alongside the always-visible inline form).
 */
export function AddTradeDialog({
  accounts,
  activeAccountId,
  strategies,
  nextStakeSuggestion,
  children,
}: {
  accounts: AccountLite[];
  activeAccountId: string | null;
  strategies: StrategyLite[];
  nextStakeSuggestion?: NextStakeSuggestion | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          startTransition(async () => router.refresh());
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a trade</DialogTitle>
        </DialogHeader>
        <AddTradeForm
          accounts={accounts}
          activeAccountId={activeAccountId}
          strategies={strategies}
          nextStakeSuggestion={nextStakeSuggestion}
        />
      </DialogContent>
    </Dialog>
  );
}
