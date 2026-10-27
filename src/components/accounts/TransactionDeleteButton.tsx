"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/trader/ConfirmDialog";
import { deleteTransactionAction } from "@/server/actions/transactions";
import { toast } from "@/hooks/use-toast";

export function TransactionDeleteButton({
  transactionId,
  tradingAccountId,
}: {
  transactionId: string;
  tradingAccountId: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <ConfirmDialog
      destructive
      trigger={
        <Button variant="ghost" size="icon" className="size-7" aria-label="Delete transaction">
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      }
      title="Delete this transaction?"
      description="The account balance will be automatically recomputed. This cannot be undone — the row is removed from the ledger."
      confirmLabel="Delete"
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("transactionId", transactionId);
        startTransition(async () => {
          const res = await deleteTransactionAction(fd);
          if (res.ok) {
            toast({ title: "Deleted", description: res.message });
            router.refresh();
          } else {
            toast({ title: "Failed", description: res.message, variant: "destructive" });
          }
        });
      }}
    />
  );
}
