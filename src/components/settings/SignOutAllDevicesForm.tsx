"use client";

import { useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, LogOut } from "lucide-react";
import { signOutAllDevicesAction } from "@/server/actions/oauth";

/**
 * Phase 25 — "Sign out of all devices" form. The user types their current
 * password to re-authenticate (spec point 7); the action bumps
 * `sessionVersion` so all other JWTs are stripped on the next sessionVersion
 * check (≤60s, see `lib/auth.ts` jwt callback). After the action succeeds we
 * also sign out the current session (the current token is also stale — its
 * sessionVersion doesn't match the freshly-incremented DB value).
 *
 * Note: this only signs the user out of RiskGuard sessions. It does NOT
 * revoke the user's Google session (spec point 7: "Make sure sign out does
 * not revoke or log the user out of their Google account itself"). The
 * Google account is untouched.
 */
export function SignOutAllDevicesForm({ hasPassword }: { hasPassword: boolean }) {
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  if (!hasPassword) {
    return (
      <section className="rounded-lg border border-border p-5 space-y-2">
        <h2 className="font-semibold flex items-center gap-2">
          <LogOut className="size-4" aria-hidden="true" />
          Sign out of all devices
        </h2>
        <p className="text-sm text-muted-foreground">
          You signed up with Google and don&apos;t have a password yet. Set a password first to
          re-authenticate, then come back here to sign out of all devices.
        </p>
      </section>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("confirmPassword", password);
    startTransition(async () => {
      const res = await signOutAllDevicesAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      // Brief delay so the success message is visible, then sign out the
      // current session (this also destroys the now-stale JWT).
      setTimeout(() => {
        startTransition(async () => {
          await signOut({ redirect: true, callbackUrl: "/login" });
        });
      }, 800);
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-5 space-y-4" noValidate>
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <LogOut className="size-4" aria-hidden="true" />
          Sign out of all devices
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Re-enter your password to confirm. All other devices will be signed out within 60 seconds.
          This does not sign you out of your Google account itself.
        </p>
      </div>
      <Field label="Confirm password" htmlFor="signout-all-pw" error={fieldErrors.confirmPassword}>
        <Input
          id="signout-all-pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
          required
        />
      </Field>
      <FormError message={error} />
      <FormSuccess message={success} />
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" aria-hidden="true" />
            Signing out…
          </>
        ) : (
          "Sign out of all devices"
        )}
      </Button>
    </form>
  );
}
