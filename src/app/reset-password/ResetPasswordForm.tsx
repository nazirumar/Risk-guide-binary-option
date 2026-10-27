"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetPasswordAction } from "@/server/actions/auth";

const PASSWORD_RULES = [
  "At least 8 characters",
  "At least one uppercase letter",
  "At least one lowercase letter",
  "At least one digit",
  "At least one special character",
];

export function ResetPasswordForm({ token }: { token: string }) {
  const [form, setForm] = useState({ password: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("token", token);
    fd.set("password", form.password);
    fd.set("confirmPassword", form.confirmPassword);
    startTransition(async () => {
      const res = await resetPasswordAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess(res.message);
      setTimeout(() => router.push("/login"), 2000);
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <Field
        label="New password"
        htmlFor="password"
        error={fieldErrors.password}
        hint={PASSWORD_RULES.join(" · ")}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field
        label="Confirm new password"
        htmlFor="confirmPassword"
        error={fieldErrors.confirmPassword}
      >
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={form.confirmPassword}
          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          disabled={pending}
        />
      </Field>
      <FormError message={error} />
      <FormSuccess message={success} />
      <Button type="submit" disabled={pending} className="w-full h-11">
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
