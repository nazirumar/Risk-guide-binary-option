import Link from "next/link";
import { AuthShell, Field, FormError } from "@/components/auth/AuthShell";
import { GoogleSignInButton, OrDivider } from "@/components/auth/GoogleSignInButton";
import { LoginForm } from "./LoginForm";

/**
 * Phase 25 — /login page now renders the "Continue with Google" button
 * above the email/password form (only when GOOGLE/AUTH_GOOGLE env var is
 * set — see GoogleSignInButtonDisabledSafe below for the gate). OAuth
 * error codes from Auth.js are mapped to friendly messages — never
 * expose raw error codes.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const callbackUrl = sp.from ? encodeURIComponent(sp.from) : "/app/dashboard";

  // OAuth error → friendly message. Raw error codes are never surfaced.
  const errorMap: Record<string, string> = {
    CredentialsSignin: "Invalid email or password.",
    EMAIL_NOT_VERIFIED: "Please verify your email before signing in.",
    OAuthSignin: "Couldn't start Google sign-in. Please try again.",
    OAuthCallback: "Google sign-in failed. Please try again.",
    OAuthCreateAccount: "We couldn't create your account from Google. Please try again.",
    OAuthAccountNotLinked:
      "This email is already linked to a different sign-in method. Sign in with that method first.",
    AccessDenied: "Sign-in was cancelled or denied.",
    OAUTH_EMAIL_NOT_VERIFIED:
      "Google hasn't verified your email. Use a verified Google account, or sign up with email and password.",
    OAUTH_RATE_LIMITED: "Too many sign-in attempts. Try again in a few minutes.",
    OAUTH_NO_EMAIL: "Your Google account didn't provide an email address.",
    OAUTH_ACCOUNT_CONFLICT: "This Google account is already linked to another RiskGuard account.",
    Configuration: "Sign-in is temporarily unavailable. Please contact support if this persists.",
    Default: "Sign-in failed. Please try again.",
  };
  const error = sp.error ? (errorMap[sp.error] ?? errorMap.Default) : undefined;

  // Only render the Google button if a Google client is configured. We
  // check via the env var (server-side). This keeps the sandbox clean.
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID);

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your RiskGuard workspace"
      footer={
        <>
          Don't have an account?{" "}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <FormError message={error} />
      {googleEnabled && (
        <>
          <GoogleSignInButton callbackUrl={callbackUrl} />
          <OrDivider />
        </>
      )}
      <LoginForm callbackUrl={callbackUrl} />
      <div className="mt-4 text-center text-xs text-muted-foreground">
        <Link href="/forgot-password" className="hover:underline">
          Forgot password?
        </Link>
      </div>
      <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
        <strong>Demo account:</strong> demo@riskguard.app / riskguard1234
      </div>
    </AuthShell>
  );
}
