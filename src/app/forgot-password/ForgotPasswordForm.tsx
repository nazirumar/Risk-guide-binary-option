"use client";

import { useState, useTransition } from "react";
import { Field, FormSuccess, FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { forgotPasswordAction } from "@/server/actions/auth";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setMessage(undefined);
    const fd = new FormData();
    fd.set("email", email);
    startTransition(async () => {
      const res = await forgotPasswordAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setMessage(res.message);
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <Field label="Email" htmlFor="email" error={error}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
          placeholder="you@example.com"
        />
      </Field>
      <FormSuccess message={message} />
      <FormError message={error} />
      <Button type="submit" disabled={pending} className="w-full h-11">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
