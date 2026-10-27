import { cn } from "@/lib/utils";
import { LucideIcon, HardHat } from "lucide-react";

/**
 * PagePlaceholder — every Phase 3 nav route renders this so the shell can be
 * exercised end-to-end before later phases ship the actual feature. Real
 * content arrives Phase 4+.
 */
export function PagePlaceholder({
  title,
  description,
  phase,
  icon: Icon = HardHat,
  className,
}: {
  title: string;
  description: string;
  phase: string;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 sm:p-8 text-center">
        <Icon className="mx-auto size-8 text-muted-foreground mb-3" aria-hidden="true" />
        <h2 className="text-base font-semibold">Coming in {phase}</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
          The shell, navigation, theming, and design tokens are live — the functional feature ships
          in {phase} as part of the project plan.
        </p>
      </div>
    </div>
  );
}
