"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "./nav-items";

/**
 * Collapsible desktop sidebar. Persists its collapsed/expanded state in
 * localStorage so it survives reloads. Hidden on mobile where the bottom
 * tab bar takes over.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "hidden sm:flex flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 sticky top-0 h-screen",
        collapsed ? "w-16" : "w-60",
      )}
      data-collapsed={collapsed}
    >
      {/* Brand */}
      <Link
        href="/app/dashboard"
        className="flex items-center gap-2 h-14 px-4 border-b border-sidebar-border hover:bg-sidebar-accent transition-colors"
      >
        <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
        </div>
        {!collapsed && <span className="text-base font-bold tracking-tight">RiskGuard</span>}
      </Link>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3" aria-label="Sections">
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center gap-3 h-10 rounded-md text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          className="w-full"
        >
          {collapsed ? (
            <ChevronRight className="size-4" aria-hidden="true" />
          ) : (
            <ChevronLeft className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </aside>
  );
}
