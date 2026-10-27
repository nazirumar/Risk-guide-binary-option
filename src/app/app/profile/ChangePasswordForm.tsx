"use client";

import { useState, useTransition } from "react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePasswordAction } from "@/server/actions/profile";

export function ChangePasswordForm() {
  const [form, setForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setFieldErrors({});
    const fd = new FormData();
    fd.set("currentPassword", form.currentPassword);
    fd.set("newPassword", form.newPassword);
    fd.set("confirmPassword", form.confirmPassword);
    startTransition(async () => {
      const res = await changePasswordAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setMessage(res.message);
      setForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-5 space-y-4" noValidate>
      <h2 className="font-semibold">Change password</h2>
      <Field label="Current password" htmlFor="currentPassword" error={fieldErrors.currentPassword}>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          value={form.currentPassword}
          onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label="New password" htmlFor="newPassword" error={fieldErrors.newPassword}>
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
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
          type="password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          disabled={pending}
        />
      </Field>
      <FormError message={error} />
      <FormSuccess message={message} />
      <Button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
