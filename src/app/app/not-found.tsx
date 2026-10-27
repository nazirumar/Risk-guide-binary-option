import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";

export default function AppNotFound() {
  return (
    <div className="text-center space-y-4 max-w-md mx-auto mt-10">
      <Compass className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-2xl font-bold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This page doesn&apos;t exist within the RiskGuard app, or you don&apos;t have access to it.
      </p>
      <Button asChild>
        <Link href="/app/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
