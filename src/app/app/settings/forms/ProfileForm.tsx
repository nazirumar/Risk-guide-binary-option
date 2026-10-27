"use client";

import { useState, useTransition } from "react";
import { Field, FormError, FormSuccess } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateProfileAction } from "@/server/actions/profile";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "NGN", "JPY", "AUD", "CAD"];
const COMMON_TIMEZONES = [
  "UTC",
  "Africa/Lagos",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Singapore",
];

export function ProfileForm({
  defaults,
}: {
  defaults: { name: string; timezone: string; baseCurrency: string };
}) {
  const [form, setForm] = useState(defaults);
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
    fd.set("name", form.name);
    fd.set("timezone", form.timezone);
    fd.set("baseCurrency", form.baseCurrency);
    startTransition(async () => {
      const res = await updateProfileAction(fd);
      if (!res.ok) {
        setError(res.message);
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        return;
      }
      setMessage(res.message);
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-5 space-y-4" noValidate>
      <h2 className="font-semibold">Account details</h2>
      <Field label="Name" htmlFor="name" error={fieldErrors.name}>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label="Base currency" htmlFor="baseCurrency" error={fieldErrors.baseCurrency}>
        <select
          id="baseCurrency"
          value={form.baseCurrency}
          onChange={(e) => setForm({ ...form, baseCurrency: e.target.value.toUpperCase() })}
          disabled={pending}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Timezone" htmlFor="timezone" error={fieldErrors.timezone}>
        <select
          id="timezone"
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          disabled={pending}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>
      <FormError message={error} />
      <FormSuccess message={message} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
