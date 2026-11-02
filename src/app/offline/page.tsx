import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

export const metadata = {
  title: "RiskGuard — Offline",
  description: "You're offline. Reconnect to continue using RiskGuard.",
};

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-background text-foreground">
      <Logo className="size-16 mb-4" />
      <h1 className="text-2xl font-bold tracking-tight">You&apos;re offline</h1>
      <p className="text-sm text-muted-foreground mt-2 max-w-sm text-center">
        RiskGuard can&apos;t reach the server. Your trades, balances, and risk rules are safe —
        reconnect to continue tracking. Check your internet connection and try again.
      </p>
      <Link
        href="/app/dashboard"
        className="mt-6 inline-flex items-center justify-center h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium"
      >
        Try again
      </Link>
    </main>
  );
}
