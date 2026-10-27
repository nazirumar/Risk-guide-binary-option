/**
 * `requireUser()` — server-side helper that returns the authenticated user
 * (with userId and key flags) or throws a redirect to /login.
 *
 * Use in Server Components, Server Actions, and Route Handlers:
 *
 *   import { requireUser } from "@/server/lib/require-user";
 *
 *   export async function someServerAction() {
 *     const { userId } = await requireUser();
 *     return db.trade.findMany({ where: { userId } }); // rule #3 scoping
 *   }
 *
 * Behavior:
 *   - If no session → throws NEXT_REDIRECT to /login
 *   - If user doesn't exist in DB (deleted, stale JWT) → throws NEXT_REDIRECT to /login
 *   - If user is not email-verified → throws NEXT_REDIRECT to /verify-email
 *   - If user is verified but not onboarded → throws NEXT_REDIRECT to /onboarding
 *     UNLESS opts.skipOnboardingCheck is true (used by the onboarding page
 *     itself to avoid an infinite redirect loop).
 *   - Otherwise → returns { userId, email, name, isOnboarded, emailVerified, timezone, baseCurrency }
 *
 * IMPORTANT: Always verifies the user exists in the DB (one query per call).
 * This prevents foreign key constraint violations when a JWT references a
 * deleted user (e.g., after the test suite clears all users and the seed
 * re-creates them with new IDs). The old JWT's userId no longer exists →
 * requireUser redirects to /login instead of returning a stale userId.
 */
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export type AuthenticatedUser = {
  userId: string;
  email: string;
  name: string | null;
  isOnboarded: boolean;
  emailVerified: Date | null;
  timezone: string;
  baseCurrency: string;
};

export async function requireUser(
  opts: { skipOnboardingCheck?: boolean } = {},
): Promise<AuthenticatedUser> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect("/login");
  }

  // Always verify the user exists in the DB. The JWT may reference a userId
  // that was deleted (e.g., by the test suite or a re-seed). Without this
  // check, the stale userId would cause foreign key constraint violations
  // when used in CREATE operations (e.g., createTradingAccountAction).
  const fresh = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      isOnboarded: true,
      emailVerified: true,
      timezone: true,
      baseCurrency: true,
    },
  });
  if (!fresh) {
    // User was deleted or the JWT is stale — redirect to login so the user
    // gets a fresh session with a valid userId.
    redirect("/login");
  }

  const { isOnboarded, emailVerified, timezone, baseCurrency } = fresh;

  // Email-verified gate first.
  if (!emailVerified) {
    redirect("/verify-email");
  }
  // Onboarding gate — skippable so the onboarding page itself can render
  // (otherwise it would create an infinite redirect: layout → onboarding →
  // layout → onboarding …).
  if (!opts.skipOnboardingCheck && !isOnboarded) {
    redirect("/onboarding");
  }

  return {
    userId: fresh.id,
    email: fresh.email,
    name: fresh.name,
    isOnboarded,
    emailVerified,
    timezone,
    baseCurrency,
  };
}
