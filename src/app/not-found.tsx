import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";

/**
 * not-found.tsx — catches 404s across the whole app (both / and /app/*).
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <Compass className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-bold tracking-tight">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist, has been moved, or you don&apos;t
          have access to it.
        </p>
        <div className="flex gap-2 justify-center">
          <Button asChild>
            <Link href="/">Home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/dashboard">Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
