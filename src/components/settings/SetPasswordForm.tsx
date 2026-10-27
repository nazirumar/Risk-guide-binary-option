"use client";

import { useState, useTransition } from "react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setPasswordAction } from "@/server/actions/profile";

const PASSWORD_RULES = ["At least 8 characters", "Upper + lower + digit + special"];

/**
 * Phase 25 — "Set a password" form shown only when the user signed up via
 * Google and has no passwordHash. Lets them add email/password login
 * alongside Google. After setting a password, they can disconnect Google
 * from the Connected accounts section.
 *
 * No currentPassword field — Google-only users don't have one. The server
 * action `setPasswordAction` enforces this (returns an error if a hash
 * already exists, redirecting to the regular Change password form).
 */
export function SetPasswordForm() {
  const [form, setForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("newPassword", form.newPassword);
    fd.set("confirmPassword", form.confirmPassword);
    startTransition(async () => {
      const res = await setPasswordAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      setForm({ newPassword: "", confirmPassword: "" });
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-5 space-y-4" noValidate>
      <div>
        <h2 className="font-semibold">Set a password</h2>
        <p className="text-xs text-muted-foreground mt-1">
          You signed up with Google. Set a password to enable email/password sign-in as a backup, or
          so you can disconnect your Google account.
        </p>
      </div>
      <Field
        label="New password"
        htmlFor="newPassword"
        error={fieldErrors.newPassword}
        hint={PASSWORD_RULES.join(" · ")}
      >
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          disabled={pending}
          required
        />
      </Field>
      <Field
        label="Confirm new password"
        htmlFor="confirmPassword"
        error={fieldErrors.confirmPassword}
      >
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          disabled={pending}
          required
        />
      </Field>
      <FormError message={error} />
      <FormSuccess message={success} />
      <Button type="submit" disabled={pending}>
        {pending ? "Setting…" : "Set password"}
      </Button>
    </form>
  );
}
