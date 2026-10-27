import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LucideIcon } from "lucide-react";
import Link from "next/link";

/**
 * EmptyState — replaces blank "no data here" panels with a clear message +
 * optional action. Used in dashboard when no trades, in tables when filters
 * return nothing, etc.
 *
 * NOTE: This is a server component (no "use client") so icons can be passed
 * as props from server parents. Actions are therefore link-based, not
 * callback-based — pass `actionLabel` + `actionHref` and EmptyState renders
 * a Link-wrapped Button. For interactive actions (toasts, state mutations),
 * callers pass a ready-to-render `action` ReactNode (typically a client
 * component with its own onClick).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actionLabel,
  actionHref,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center p-8 gap-3 rounded-lg border border-dashed border-border bg-muted/30",
        className,
      )}
      role="status"
    >
      {Icon && (
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground max-w-sm">{description}</p>}
      {action ? (
        action
      ) : actionLabel && actionHref ? (
        <Button asChild className="mt-1">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}
