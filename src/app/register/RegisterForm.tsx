"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { registerAction } from "@/server/actions/auth";

const PASSWORD_RULES = [
  "At least 8 characters",
  "At least one uppercase letter",
  "At least one lowercase letter",
  "At least one digit",
  "At least one special character",
];

export function RegisterForm() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    acceptTerms: false,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});

    const fd = new FormData();
    fd.set("name", form.name);
    fd.set("email", form.email);
    fd.set("password", form.password);
    fd.set("confirmPassword", form.confirmPassword);
    fd.set("acceptTerms", form.acceptTerms ? "on" : "");

    startTransition(async () => {
      const res = await registerAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setSuccess("Account created. Check your email for a verification link.");
      // Wait a moment so the user sees the success message, then push to
      // /verify-email?email=... where they can paste the token or wait.
      setTimeout(() => {
        router.push(`/verify-email?email=${encodeURIComponent(form.email)}`);
      }, 1500);
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <Field label="Name" htmlFor="name" error={fieldErrors.name}>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label="Email" htmlFor="email" error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          disabled={pending}
          placeholder="you@example.com"
        />
      </Field>
      <Field
        label="Password"
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
          onChange={(e) => set("password", e.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirmPassword" error={fieldErrors.confirmPassword}>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={form.confirmPassword}
          onChange={(e) => set("confirmPassword", e.target.value)}
          disabled={pending}
        />
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id="acceptTerms"
          checked={form.acceptTerms}
          onCheckedChange={(v) => set("acceptTerms", v === true)}
          disabled={pending}
        />
        <label htmlFor="acceptTerms" className="text-xs text-muted-foreground leading-relaxed">
          I understand that binary options are high risk and that RiskGuard is a tracking tool — not
          financial advice.
        </label>
      </div>
      {fieldErrors.acceptTerms && (
        <p role="alert" className="text-xs text-destructive">
          {fieldErrors.acceptTerms}
        </p>
      )}
      <FormError message={error} />
      <FormSuccess message={success} />
      <Button type="submit" disabled={pending} className="w-full h-11">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
