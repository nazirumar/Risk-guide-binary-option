import { Sidebar } from "@/components/shell/Sidebar";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { TopBar } from "@/components/shell/TopBar";
import { RiskDisclaimer } from "@/components/trader/RiskDisclaimer";
import { LockoutBanner } from "@/components/risk/LockoutBanner";
import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { getActiveLockout } from "@/server/lib/risk-check";
import { db } from "@/lib/db";

/**
 * Authenticated app shell — gates access (requireUser) then renders:
 *   - Collapsible sidebar (desktop) + bottom tab bar (mobile)
 *   - Top bar with account switcher / theme toggle / notifications / user menu
 *   - Sticky LockoutBanner (only if there's an active non-overridden lockout)
 *   - Main content
 *   - Persistent risk-disclaimer footer (rule #11)
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const [activeAccount, accounts, notifications, activeLockout] = await Promise.all([
    getActiveAccount(),
    listUserAccounts(),
    db.notification.findMany({
      where: { userId: user.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        body: true,
        readAt: true,
        createdAt: true,
        type: true,
      },
    }),
    getActiveLockout(user.userId),
  ]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          user={{ email: user.email, name: user.name }}
          accounts={accounts}
          activeAccount={activeAccount}
          notifications={notifications}
        />
        {/* Sticky lockout banner — shown on every /app/* page if there's an
            active non-expired non-overridden lockout. Countdown timer ticks
            client-side every second. */}
        <LockoutBanner
          lockout={
            activeLockout
              ? {
                  id: activeLockout.id,
                  reason: activeLockout.reason,
                  startedAt: activeLockout.startedAt.toISOString(),
                  expiresAt: activeLockout.expiresAt ? activeLockout.expiresAt.toISOString() : null,
                }
              : null
          }
        />
        <main className="flex-1 px-3 sm:px-5 lg:px-8 py-4 sm:py-6 pb-20 sm:pb-6">{children}</main>
        <footer className="px-3 sm:px-5 lg:px-8 py-3 border-t border-border">
          <RiskDisclaimer variant="compact" />
        </footer>
      </div>
      <BottomTabBar />
    </div>
  );
}
