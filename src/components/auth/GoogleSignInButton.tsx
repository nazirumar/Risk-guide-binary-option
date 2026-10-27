"use client";

import { useState, useTransition } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Phase 25 — "Continue with Google" button. Uses the official 4-color Google
 * "G" logo (SVG, no external asset dependency) and an accessible label that
 * screen readers will announce. Loading state via useTransition. On success
 * Auth.js redirects to the OAuth flow; we don't need to handle the redirect
 * ourselves (Auth.js's signIn with `redirect: true` (the default) sends the
 * browser through Google and back to /api/auth/callback/google, which then
 * redirects to either /onboarding (new user) or /app/dashboard (returning).
 *
 * If the OAuth flow fails (access denied, email not verified, rate limit),
 * Auth.js bounces back to /login?error=<CODE> and the LoginPage maps the
 * error code to a friendly message.
 */
export function GoogleSignInButton({
  callbackUrl,
  label = "Continue with Google",
  disabled = false,
}: {
  callbackUrl?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const params = useSearchParams();
  const [error, setError] = useState<string | undefined>(undefined);

  // Compute callbackUrl: caller can pass one, else fall back to `?from=` if
  // present, else /app/dashboard (matches LoginPage's existing behavior).
  const dest =
    callbackUrl ??
    (params.get("from") ? encodeURIComponent(params.get("from")!) : "/app/dashboard");

  function onClick() {
    setError(undefined);
    startTransition(async () => {
      // `redirect: true` is the default — we want the browser to actually
      // navigate so the OAuth round-trip happens. If we used redirect: false
      // we'd have to handle the callback URL ourselves.
      await signIn("google", { callbackUrl: dest });
      // Note: with redirect: true, this promise resolves only on completion
      // of the OAuth flow back to the callback. Errors are surfaced via
      // the URL ?error param on /login.
    });
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || disabled}
        aria-label={label}
        className={cn(
          "inline-flex items-center justify-center gap-3 h-11 w-full rounded-md border border-input bg-background px-4 text-sm font-medium",
          "hover:bg-accent hover:text-accent-foreground transition-colors",
          "disabled:opacity-60 disabled:pointer-events-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <GoogleLogo className="size-5" aria-hidden="true" />
        <span>{pending ? "Redirecting to Google…" : label}</span>
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive text-center">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Official 4-color Google "G" logo as an inline SVG. Source: official Google
 * brand guidelines (https://about.google/brand-resource-center/). Using the
 * SVG directly avoids any external image asset dependency.
 */
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/**
 * "or" divider — sits between the Google button and the email/password form.
 * Uses the same visual treatment as the rest of the auth shell (border-border,
 * muted-foreground).
 */
export function OrDivider() {
  return (
    <div className="relative my-2">
      <div className="absolute inset-0 flex items-center" aria-hidden="true">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-background px-3 text-xs uppercase tracking-wider text-muted-foreground">
          or
        </span>
      </div>
    </div>
  );
}
