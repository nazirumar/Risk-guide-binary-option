"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { restoreTradingAccountAction } from "@/server/actions/accounts";
import { toast } from "@/hooks/use-toast";

export function RestoreAccountButton({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={`Restore ${accountName}`}
      disabled={pending}
      onClick={async () => {
        const fd = new FormData();
        fd.set("tradingAccountId", accountId);
        startTransition(async () => {
          const res = await restoreTradingAccountAction(fd);
          if (res.ok) {
            toast({ title: "Account restored", description: res.message });
            router.refresh();
          } else {
            toast({ title: "Restore failed", description: res.message, variant: "destructive" });
          }
        });
      }}
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
