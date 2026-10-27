"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MOBILE_NAV_ITEMS } from "./nav-items";

/**
 * Bottom tab bar — mobile-only navigation. Fixed to the bottom of the
 * viewport, shows the first 4-5 nav items with an icon + short label.
 *
 * Hidden on sm+ screens where the sidebar takes over.
 */
export function BottomTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:hidden"
    >
      <div className="grid grid-cols-5 h-14">
        {MOBILE_NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
              <span>{item.shortLabel ?? item.label}</span>
            </Link>
          );
        })}
        {/* 5th slot: notifications (always visible on mobile bottom bar) */}
        <Link
          href="/app/notifications"
          aria-label="Notifications"
          className="flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
        >
          <Bell className="size-5" aria-hidden="true" />
          <span>Alerts</span>
        </Link>
      </div>
    </nav>
  );
}
