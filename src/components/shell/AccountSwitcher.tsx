"use client";

import { useState, useTransition } from "react";
import { ChevronsUpDown, Check, Wallet } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { AccountType } from "@prisma/client";
import { setActiveAccountId } from "@/server/actions/active-account";
import { useRouter } from "next/navigation";

// NOTE: currentBalance is a string, not Prisma Decimal — server actions
// stringify Decimal fields before crossing the server→client boundary
// (Decimal objects can't be serialized across RSC payloads).
type AccountLite = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: AccountType;
  currentBalance: string;
};

/**
 * AccountSwitcher — dropdown that lists the user's non-archived accounts and
 * switches the active account (cookie-backed via setActiveAccountId server
 * action). The current account's name + balance is shown on the trigger.
 *
 * If the user has no accounts, renders a "Create account" CTA button instead.
 */
export function AccountSwitcher({
  accounts,
  activeAccount,
}: {
  accounts: AccountLite[];
  activeAccount: AccountLite | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (accounts.length === 0) {
    return (
      <Button asChild size="sm" variant="outline">
        <a href="/app/accounts">Create account</a>
      </Button>
    );
  }

  async function onSelect(id: string) {
    if (id === activeAccount?.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const res = await setActiveAccountId(id);
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 gap-2 max-w-[200px] sm:max-w-xs justify-between"
          disabled={pending}
          aria-label={`Active account: ${activeAccount?.name ?? "select"}`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <Wallet className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex flex-col items-start leading-tight min-w-0">
              <span className="text-xs text-muted-foreground truncate w-full text-left">
                {activeAccount?.broker ?? ""}
              </span>
              <span className="text-sm font-medium truncate w-full text-left">
                {activeAccount?.name ?? "Select account"}
              </span>
            </span>
            {activeAccount && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] py-0 px-1.5",
                  activeAccount.type === "DEMO"
                    ? "border-muted-foreground/30 text-muted-foreground"
                    : "border-warning text-warning",
                )}
              >
                {activeAccount.type}
              </Badge>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-[280px] p-1" align="start">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 py-1.5">
          Your accounts
        </div>
        <div className="max-h-80 overflow-y-auto">
          {accounts.map((a) => {
            const isActive = a.id === activeAccount?.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onSelect(a.id)}
                disabled={pending}
                className={cn(
                  "w-full flex items-center justify-between gap-3 px-2 py-2 rounded-md text-sm hover:bg-accent text-left",
                  isActive && "bg-accent",
                )}
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{a.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {a.broker} · {a.currency}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatMoney(a.currentBalance, a.currency)}
                  </span>
                  {isActive && <Check className="size-4 text-primary" aria-hidden="true" />}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
