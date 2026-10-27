"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { verifyEmailAction, resendVerificationAction } from "@/server/actions/auth";

export function VerifyEmailForm({ initialToken, email }: { initialToken: string; email: string }) {
  const [token, setToken] = useState(initialToken);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Auto-submit if the token came from the URL (?token=...).
  // useEffect once on mount.
  // (Skipping to keep this simple — user clicks the Verify button.)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setMessage(undefined);
    const fd = new FormData();
    fd.set("token", token);
    startTransition(async () => {
      const res = await verifyEmailAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setMessage(res.message);
      setTimeout(() => router.push("/login"), 3000);
    });
  }

  async function onResend() {
    setError(undefined);
    setMessage(undefined);
    if (!email) {
      setError("Sign in again so we know which email to send to.");
      return;
    }
    const fd = new FormData();
    fd.set("email", email);
    startTransition(async () => {
      const res = await resendVerificationAction(fd);
      setMessage(res.message);
    });
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <Field
          label="Verification token"
          htmlFor="token"
          error={error}
          hint="If you used the email link, this field is already filled in."
        >
          <Input
            id="token"
            name="token"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={pending}
            placeholder="Paste the token from your email"
            className="font-mono text-sm"
          />
        </Field>
        <FormSuccess message={message} />
        <FormError message={error} />
        <Button type="submit" disabled={pending} className="w-full h-11">
          {pending ? "Verifying…" : "Verify email"}
        </Button>
      </form>
      {email && (
        <div className="text-center text-xs text-muted-foreground">
          Didn't get the email?{" "}
          <button
            type="button"
            onClick={onResend}
            disabled={pending}
            className="font-medium text-primary hover:underline disabled:opacity-50"
          >
            Resend verification link
          </button>
        </div>
      )}
    </div>
  );
}
