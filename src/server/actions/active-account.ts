"use server";

/**
 * Active trading-account context (PROJECT_RULES.md Phase 3 spec).
 *
 * The user's currently-selected TradingAccount is persisted in a cookie so
 * every server-side render reads the right account without round-tripping
 * to a server action. The cookie stores the tradingAccountId; validity is
 * re-checked on every read (user might have archived or deleted the account).
 *
 * Server actions: getActiveAccountId(), setActiveAccountId(id). The client
 * shell uses useActiveAccount() (client hook) which calls these.
 *
 * NOTE: a "use server" file can ONLY export async functions — non-async
 * values like the cookie name live in `./active-account-cookie.ts`.
 */
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { requireUser } from "@/server/lib/require-user";
import { ACTIVE_ACCOUNT_COOKIE } from "@/server/lib/active-account-cookie";

/**
 * Read the active account id from the cookie. Falls back to the user's
 * first non-archived account if no cookie is set or the cookie points to an
 * account the user doesn't own / has archived.
 *
 * Returns null if the user has no accounts at all (just onboarded).
 */
export async function getActiveAccountId(): Promise<string | null> {
  const { userId } = await requireUser();
  const store = await cookies();
  const cookieValue = store.get(ACTIVE_ACCOUNT_COOKIE)?.value;

  if (cookieValue) {
    // Validate the cookie still points to one of the user's active accounts.
    const acc = await db.tradingAccount.findFirst({
      where: { id: cookieValue, userId, isArchived: false },
      select: { id: true },
    });
    if (acc) return acc.id;
  }

  // No valid cookie — fall back to first account.
  // NOTE: we don't write the fallback to the cookie here because cookies()
  // can only be modified inside a Server Action or Route Handler, not during
  // a Server Component render. The fallback will be persisted the next time
  // the user explicitly switches accounts via setActiveAccountId(). This
  // means the DB lookup runs on every render until the user picks an account
  // — acceptable for Phase 3, revisit with a setter call from the client if
  // it shows up in profiling.
  const first = await db.tradingAccount.findFirst({
    where: { userId, isArchived: false },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return first?.id ?? null;
}

/**
 * Switch the active account. Validates ownership + non-archived before setting
 * the cookie.
 */
export async function setActiveAccountId(
  accountId: string,
): Promise<{ ok: boolean; message?: string }> {
  const { userId } = await requireUser();
  const acc = await db.tradingAccount.findFirst({
    where: { id: accountId, userId, isArchived: false },
    select: { id: true },
  });
  if (!acc) {
    return { ok: false, message: "Account not found or archived." };
  }
  (await cookies()).set(ACTIVE_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return { ok: true };
}

/**
 * Returns the full TradingAccount row for the active account (or null).
 */
export async function getActiveAccount() {
  const id = await getActiveAccountId();
  if (!id) return null;
  // Stringify the Decimal balance — Prisma Decimal objects can't cross the
  // server→client boundary (TopBar / AccountSwitcher are client components).
  const a = await db.tradingAccount.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      broker: true,
      currency: true,
      type: true,
      currentBalance: true,
      isArchived: true,
    },
  });
  if (!a) return null;
  return {
    ...a,
    currentBalance: a.currentBalance.toString(),
  };
}

/**
 * Returns all of the user's non-archived accounts (for the switcher dropdown).
 */
export async function listUserAccounts() {
  const { userId } = await requireUser();
  // Stringify the Decimal balance — see getActiveAccount() for the reason.
  const accounts = await db.tradingAccount.findMany({
    where: { userId, isArchived: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      broker: true,
      currency: true,
      type: true,
      currentBalance: true,
    },
  });
  return accounts.map((a) => ({
    ...a,
    currentBalance: a.currentBalance.toString(),
  }));
}
