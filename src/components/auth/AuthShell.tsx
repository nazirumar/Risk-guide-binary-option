/**
 * Shared layout for all auth pages (/login, /register, /forgot-password,
 * /reset-password, /verify-email). Renders the brand mark, the risk
 * disclaimer (PROJECT_RULES.md rule #11) and a centered card for the page body.
 */
import Link from "next/link";
import { ShieldCheck, AlertTriangle } from "lucide-react";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground">
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center gap-3 mb-8 text-center">
            <Link href="/" className="inline-flex items-center gap-2 hover:opacity-80">
              <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
              </div>
              <span className="text-xl font-bold tracking-tight">RiskGuard</span>
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight mt-2">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>

          <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
            {children}
          </div>

          {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
        </div>
      </div>

      <footer className="border-t border-border bg-background px-4 py-6">
        <div className="max-w-md mx-auto rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          <p className="flex items-start gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Binary options carry high risk and most retail traders lose money. RiskGuard is a
              discipline and tracking tool — not financial advice.
            </span>
          </p>
        </div>
      </footer>
    </main>
  );
}

/**
 * A small "Field" wrapper that pairs a Label + an input slot + an error slot.
 * Keeps the auth pages visually consistent.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

export function FormSuccess({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
      {message}
    </div>
  );
}
