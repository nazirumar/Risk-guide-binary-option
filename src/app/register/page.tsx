import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { GoogleSignInButton, OrDivider } from "@/components/auth/GoogleSignInButton";
import { RegisterForm } from "./RegisterForm";

/**
 * Phase 25 — /register page mirrors the /login layout: Google button above
 * the email/password form, with an "or" divider. New Google users are sent
 * through the onboarding wizard on first sign-in (handled by signIn callback
 * + events.createUser; the proxy.ts /onboarding gate sends them there).
 */
export default function RegisterPage() {
  // Render the Google button only when configured.
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID);

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start enforcing discipline today"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {googleEnabled && (
        <>
          <GoogleSignInButton callbackUrl="/app/dashboard" label="Sign up with Google" />
          <OrDivider />
        </>
      )}
      <RegisterForm />
    </AuthShell>
  );
}
