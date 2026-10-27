"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Field, FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteAccountAction } from "@/server/actions/profile";

export function DeleteAccountForm({ email }: { email: string }) {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const fd = new FormData();
    fd.set("confirmPhrase", phrase);
    startTransition(async () => {
      const res = await deleteAccountAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      // Sign out client-side then bounce home — the DB row is already gone.
      await signOut({ redirect: false });
      router.push("/");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 space-y-4"
      noValidate
    >
      <div>
        <h2 className="font-semibold text-destructive">Delete account</h2>
        <p className="text-xs text-muted-foreground mt-1">
          This permanently deletes your account, all trading accounts, all trades, all sessions, and
          all settings — cascaded through every related table. This cannot be undone.
        </p>
      </div>
      <Field label={`Type "DELETE MY ACCOUNT" to confirm`} htmlFor="confirmPhrase" error={error}>
        <Input
          id="confirmPhrase"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          disabled={pending}
          autoComplete="off"
          placeholder="DELETE MY ACCOUNT"
        />
      </Field>
      <Button
        type="submit"
        variant="destructive"
        disabled={pending || phrase !== "DELETE MY ACCOUNT"}
      >
        {pending ? "Deleting…" : "Delete account permanently"}
      </Button>
    </form>
  );
}
