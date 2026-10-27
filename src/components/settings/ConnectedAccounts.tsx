"use client";

import { useState, useTransition } from "react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2 } from "lucide-react";
import { unlinkAccountAction } from "@/server/actions/oauth";

export type ConnectedAccount = {
  provider: string;
  providerAccountId: string;
  email: string | null;
  linkedAt: Date;
};

/**
 * Phase 25 — Connected accounts section for the Settings page. Lists each
 * linked OAuth provider (Google today; future providers fit the same row).
 * Shows connected email + date linked, and a Disconnect button that opens a
 * small dialog asking for the user's current password (re-auth requirement,
 * spec point 7).
 *
 * If Google is the user's only sign-in method (no passwordHash), Disconnect
 * is disabled with a hint to set a password first (spec point 6).
 */
export function ConnectedAccounts({
  accounts,
  hasPassword,
}: {
  accounts: ConnectedAccount[];
  hasPassword: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <section className="rounded-lg border border-border p-5 space-y-3">
        <h2 className="font-semibold">Connected accounts</h2>
        <p className="text-sm text-muted-foreground">
          No external accounts connected. You can link Google from the login or register page by
          clicking &ldquo;Continue with Google&rdquo;.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border p-5 space-y-4">
      <div>
        <h2 className="font-semibold">Connected accounts</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Manage OAuth providers linked to your RiskGuard account. Disconnect requires
          re-authentication with your password.
        </p>
      </div>

      <ul className="divide-y divide-border">
        {accounts.map((acc) => (
          <li
            key={`${acc.provider}:${acc.providerAccountId}`}
            className="py-3 first:pt-0 last:pb-0"
          >
            <AccountRow account={acc} hasPassword={hasPassword} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountRow({ account, hasPassword }: { account: ConnectedAccount; hasPassword: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const providerLabel = account.provider === "google" ? "Google" : account.provider;

  async function onDisconnect(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("provider", account.provider);
    fd.set("providerAccountId", account.providerAccountId);
    fd.set("confirmPassword", password);
    startTransition(async () => {
      const res = await unlinkAccountAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      setConfirming(false);
      setPassword("");
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
          {providerLabel[0]}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{providerLabel}</span>
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
              <CheckCircle2 className="size-3 mr-1" aria-hidden="true" />
              Connected
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {account.email ?? "—"} · linked{" "}
            {account.linkedAt.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      <div className="flex flex-col items-stretch sm:items-end gap-2">
        {!confirming ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !hasPassword}
            onClick={() => {
              setConfirming(true);
              setError(undefined);
              setSuccess(undefined);
            }}
            title={
              !hasPassword
                ? "Set a password in Profile before disconnecting Google."
                : "Disconnect this Google account"
            }
          >
            Disconnect
          </Button>
        ) : (
          <form onSubmit={onDisconnect} className="grid gap-2 sm:w-80">
            <Field
              label="Confirm password to disconnect"
              htmlFor={`disconnect-pw-${account.providerAccountId}`}
              error={fieldErrors.confirmPassword}
            >
              <Input
                id={`disconnect-pw-${account.providerAccountId}`}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
                required
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" size="sm" disabled={pending}>
                {pending ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" aria-hidden="true" />
                    Disconnecting…
                  </>
                ) : (
                  "Disconnect"
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  setPassword("");
                  setError(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        <FormError message={error} />
        <FormSuccess message={success} />
      </div>
    </div>
  );
}
