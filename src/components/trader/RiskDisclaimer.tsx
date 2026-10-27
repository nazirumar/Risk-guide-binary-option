import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * RiskDisclaimer — the persistent amber-bordered footer the spec requires.
 * (PROJECT_RULES.md rule #11: app must include a visible risk disclaimer.)
 *
 * Renders the long-form version by default; `variant="compact"` shows a
 * one-liner for use inside layouts with limited space.
 */
export function RiskDisclaimer({
  variant = "full",
  className,
}: {
  variant?: "full" | "compact";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        variant === "full" ? "p-4 text-sm" : "p-2.5 text-xs",
        className,
      )}
      role="note"
    >
      <p className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          {variant === "full" ? (
            <>
              <strong className="block font-semibold mb-1">Risk Disclaimer</strong>
              Binary options and other short-term derivative products carry a high level of risk and
              can result in the loss of your entire investment. The majority of retail traders lose
              money. RiskGuard is a discipline and tracking tool only — it does not provide
              financial advice, trade signals, or broker connectivity. Never trade with money you
              cannot afford to lose. If you have a gambling problem, contact a local support
              helpline.
            </>
          ) : (
            <>
              <strong>Risk:</strong> Binary options are high-risk; most retail traders lose money.
              RiskGuard is a discipline tool, not financial advice.
            </>
          )}
        </span>
      </p>
    </div>
  );
}
