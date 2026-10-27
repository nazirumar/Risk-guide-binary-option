import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ShieldCheck, TrendingUp, AlertTriangle, Lock, BookOpen, BarChart3 } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * Phase 2 landing page. Authenticated + onboarded users get redirected to
 * /app/dashboard; everyone else sees the marketing landing with links to
 * /login and /register. The risk disclaimer footer stays (PROJECT_RULES.md
 * rule #11).
 */
export default async function Home() {
  const session = await getServerSession(authOptions);
  if (session?.user?.emailVerified && session?.user?.isOnboarded) {
    redirect("/app/dashboard");
  }

  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-3xl w-full flex flex-col items-center text-center gap-6">
          <div className="flex items-center gap-3">
            <div className="size-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="size-7 text-primary" aria-hidden="true" />
            </div>
            <span className="text-2xl font-bold tracking-tight">RiskGuard</span>
          </div>

          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Discipline-first money management for binary options traders
          </h1>

          <p className="text-lg text-muted-foreground max-w-2xl">
            RiskGuard helps you size stakes, enforce daily loss limits, visualize your equity curve,
            and keep a tamper-proof trade journal. Built so the math always adds up — and the
            discipline never breaks.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mt-2 w-full sm:w-auto">
            <Button asChild size="lg" className="h-11 px-8">
              <Link href="/register">Get started free</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="h-11 px-6">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>

          <p className="text-xs text-muted-foreground mt-1">
            Demo account: <span className="font-mono">demo@riskguard.app</span> /{" "}
            <span className="font-mono">riskguard1234</span>
          </p>
        </div>
      </section>

      {/* Feature preview */}
      <section className="border-t border-border bg-muted/30 px-6 py-12">
        <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              icon: Lock,
              title: "Risk rules & lockouts",
              body: "Per-account max daily loss, consecutive losses, cooldowns. Auto-lockout when you breach a limit.",
            },
            {
              icon: TrendingUp,
              title: "Equity & drawdown",
              body: "See your true equity curve and drawdown — not just balance. Spot ruin-risk before it happens.",
            },
            {
              icon: BookOpen,
              title: "Trade journal",
              body: "Fast, mobile-first trade entry. Tag emotion, strategy, asset. Filter everything.",
            },
            {
              icon: BarChart3,
              title: "Analytics that matter",
              body: "Win rate, break-even, expectancy, profit factor. By asset, hour, weekday, emotion.",
            },
            {
              icon: AlertTriangle,
              title: "Martingale guardrails",
              body: "Staking plans including Martingale are OFF by default and ship with explicit red warnings.",
            },
            {
              icon: ShieldCheck,
              title: "Decimal-precise money",
              body: "All money math runs on decimal.js — never floating point. Audited per-user data isolation.",
            },
          ].map((f) => (
            <article
              key={f.title}
              className="rounded-lg border border-border bg-background p-5 flex flex-col gap-3"
            >
              <f.icon className="size-5 text-primary" aria-hidden="true" />
              <h2 className="font-semibold">{f.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Risk disclaimer — PERMANENT. See PROJECT_RULES.md rule #11. */}
      <footer className="border-t border-border bg-background px-6 py-8 mt-auto">
        <div className="max-w-5xl mx-auto rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          <p className="flex items-start gap-2">
            <AlertTriangle className="size-5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              <strong className="block font-semibold">Risk Disclaimer</strong>
              Binary options and other short-term derivative products carry a high level of risk and
              can result in the loss of your entire investment. The majority of retail traders lose
              money. RiskGuard is a discipline and tracking tool only — it does not provide
              financial advice, trade signals, or broker connectivity. Never trade with money you
              cannot afford to lose. If you have a gambling problem, contact a local support
              helpline.
            </span>
          </p>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">
          RiskGuard · Phase 2 — Auth + onboarding live ·{" "}
          <span className="tabular-nums">v0.2.0</span>
        </p>
      </footer>
    </main>
  );
}
