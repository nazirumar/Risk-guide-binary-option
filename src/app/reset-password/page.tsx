import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  if (!sp.token) {
    return (
      <AuthShell
        title="Reset password"
        footer={
          <Link href="/login" className="font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="text-sm text-muted-foreground text-center">
          This reset link is missing the token. Please open the link from your email again, or{" "}
          <Link href="/forgot-password" className="text-primary hover:underline">
            request a new reset link
          </Link>
          .
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a strong password"
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <ResetPasswordForm token={sp.token} />
    </AuthShell>
  );
}
