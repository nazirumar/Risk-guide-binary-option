import Link from "next/link";
import { AuthShell, FormSuccess, FormError } from "@/components/auth/AuthShell";
import { VerifyEmailForm } from "./VerifyEmailForm";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const sp = await searchParams;
  return (
    <AuthShell
      title="Verify your email"
      subtitle={
        sp.email
          ? `Verification link sent to ${sp.email}`
          : "Paste the verification token or click the link in your email"
      }
      footer={
        <Link href="/login" className="hover:underline">
          Back to sign in
        </Link>
      }
    >
      <VerifyEmailForm initialToken={sp.token ?? ""} email={sp.email ?? ""} />
    </AuthShell>
  );
}

export { FormSuccess, FormError };
