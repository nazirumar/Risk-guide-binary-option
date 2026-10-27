"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/trader/ConfirmDialog";
import { archiveTradingAccountAction } from "@/server/actions/accounts";
import { toast } from "@/hooks/use-toast";

/**
 * ArchiveAccountButton — uses ConfirmDialog because archive is a
 * destructive-adjacent action (the account becomes hidden from the active
 * list, though history is preserved).
 */
export function ArchiveAccountButton({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <ConfirmDialog
      destructive
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Archive ${accountName}`}
        >
          <Archive className="size-3.5" aria-hidden="true" />
        </Button>
      }
      title={`Archive ${accountName}?`}
      description={
        <span>
          The account will be hidden from your active list but its history (trades, transactions,
          balance) is preserved. You can restore it any time from the archived list.
        </span>
      }
      confirmLabel="Archive"
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("tradingAccountId", accountId);
        startTransition(async () => {
          const res = await archiveTradingAccountAction(fd);
          if (res.ok) {
            toast({ title: "Account archived", description: res.message });
            router.refresh();
          } else {
            toast({ title: "Archive failed", description: res.message, variant: "destructive" });
          }
        });
      }}
    />
  );
}
