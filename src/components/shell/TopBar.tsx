"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bell, LogOut, Settings, Menu, X } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ThemeToggle } from "./ThemeToggle";
import { AccountSwitcher } from "./AccountSwitcher";
import { NAV_ITEMS } from "./nav-items";
import { AccountType } from "@prisma/client";

// NOTE: currentBalance is a string (server action stringified the Decimal —
// Decimal objects can't cross the server→client boundary).
type AccountLite = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: AccountType;
  currentBalance: string;
};

type NotifLite = {
  id: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
  type: string;
};

/**
 * TopBar — sticky top of the authed app. Renders:
 *   - Left:  hamburger (mobile only) → full nav drawer
 *   - Center/Left: account switcher
 *   - Right: theme toggle, notifications bell w/ unread count, user menu
 */
export function TopBar({
  user,
  accounts,
  activeAccount,
  notifications,
}: {
  user: { email: string; name?: string | null };
  accounts: AccountLite[];
  activeAccount: AccountLite | null;
  notifications: NotifLite[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const unread = notifications.filter((n) => !n.readAt).length;

  const initials =
    (user.name ?? user.email ?? "?")
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* Mobile hamburger — opens the full nav drawer (bottom tab bar only
          shows 5 items, so the rest of the app is unreachable otherwise). */}
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 sm:hidden"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}
      >
        <Menu className="size-5" aria-hidden="true" />
      </Button>

      {/* Mobile: collapse account switcher to a compact trigger on very small screens */}
      <div className="flex-1 min-w-0">
        <AccountSwitcher accounts={accounts} activeAccount={activeAccount} />
      </div>

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Notifications */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
          >
            <Bell className="size-4" aria-hidden="true" />
            {unread > 0 && (
              <Badge
                variant="destructive"
                className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] py-0"
                aria-hidden="true"
              >
                {unread > 9 ? "9+" : unread}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() =>
                  startTransition(async () => {
                    const { markAllNotificationsReadAction } =
                      await import("@/server/actions/notifications");
                    await markAllNotificationsReadAction();
                    router.refresh();
                  })
                }
                disabled={pending}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                You&apos;re all caught up.
              </div>
            ) : (
              notifications.slice(0, 8).map((n) => (
                <div
                  key={n.id}
                  className={`px-3 py-2 border-b border-border last:border-0 ${!n.readAt ? "bg-muted/40" : ""}`}
                >
                  <div className="text-sm font-medium">{n.title}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2">{n.body}</div>
                </div>
              ))
            )}
          </div>
          <div className="p-2 border-t border-border">
            <Button asChild variant="ghost" size="sm" className="w-full">
              <Link href="/app/notifications">View all</Link>
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium truncate">{user.name ?? "Trader"}</span>
              <span className="text-xs text-muted-foreground truncate">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/app/settings" className="cursor-pointer">
              <Settings className="size-4 mr-2" aria-hidden="true" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive cursor-pointer"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                // Phase 25: sign out returns to /login (not "/") per spec.
                // Note: this only signs out of RiskGuard — it does NOT
                // revoke or log the user out of their Google account.
                await signOut({ redirect: true, callbackUrl: "/login" });
              });
            }}
          >
            <LogOut className="size-4 mr-2" aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mobile nav drawer — every page, not just the 5 in the bottom tab bar. */}
      <Drawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        direction="bottom"
        shouldScaleBackground={false}
      >
        <DrawerContent
          className={cn(
            // drawer.tsx caps bottom drawers at max-h-[80vh] via a
            // data-[vaul-drawer-direction=bottom] variant, which is
            // higher-specificity than a plain max-h-* override — repeat the
            // same variant here or the taller cap silently won't apply.
            // 95dvh (not vh) accounts for mobile browser dynamic toolbars.
            "h-auto flex flex-col",
            "data-[vaul-drawer-direction=bottom]:max-h-[95dvh]",
          )}
        >
          <DrawerHeader className="flex flex-row items-center justify-between">
            <DrawerTitle>Menu</DrawerTitle>
            <DrawerClose asChild>
              <Button variant="ghost" size="icon" aria-label="Close menu">
                <X className="size-5" aria-hidden="true" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          {/* The nav itself is the scroll container: a flex-1 min-h-0 item
              with overflow-y-auto is height-capped by the flex layout, while
              a nested div with h-full is NOT — percentage heights don't
              resolve against a flex item in an auto-height (max-h) column,
              which made the whole list unscrollable. */}
          <nav className="px-2 flex-1 min-h-0 overflow-y-auto pb-2" aria-label="Mobile navigation">
            <ul className="flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <DrawerClose asChild>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 h-11 rounded-md px-3 text-sm font-medium transition-colors",
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-5 shrink-0" aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </DrawerClose>
                  </li>
                );
              })}
            </ul>
          </nav>
          {/* No bottom spacer needed: the drawer is z-50, the bottom tab bar
              z-30, so the drawer paints above it. */}
        </DrawerContent>
      </Drawer>
    </header>
  );
}
