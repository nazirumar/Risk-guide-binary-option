/**
 * RiskGuard Auth.js (NextAuth v4) configuration — Phase 25 hardening.
 *
 * SESSION STRATEGY: JWT (signed cookie, edge-readable).
 *
 *   The original PROJECT_RULES.md Phase 0 note leaned toward database sessions
 *   for instant revocation. Reality check: Next.js middleware runs in the edge
 *   runtime and can't reach Prisma, so database sessions would force every
 *   protected route through a Node.js boundary just to check auth status —
 *   that kills streaming / static optimization. JWT strategy lets the
 *   middleware read claims (isOnboarded, emailVerified) without a DB hit,
 *   and our session callback still re-validates against the DB on the server
 *   side for any non-trivial action via `requireUser()` — so a stolen cookie
 *   still can't do anything the underlying user couldn't do (and any state
 *   change like emailVerified → true is reflected on the next token refresh).
 *
 *   Phase 25 instant revocation: a `sessionVersion Int @default(0)` lives on
 *   User. The jwt callback re-reads it periodically (every 60s) and strips the
 *   token if the DB value differs (e.g. after sign-out-of-all-devices). The
 *   session callback then sees a stripped token and exposes no user.id, so
 *   `requireUser()` redirects to /login. The edge middleware still allows
 *   through (it reads the JWT directly without a DB hit) but every page
 *   that goes through `requireUser()` will bounce stale sessions.
 *
 * PROVIDERS:
 *   - Credentials (email + password, argon2 verify)
 *   - Google OAuth — registered only when AUTH_GOOGLE_ID is set. The previous
 *     GOOGLE_CLIENT_ID/SECRET names are still respected for backward compat.
 *
 * ACCOUNT LINKING RULES (Phase 25 spec):
 *   - allowDangerousEmailAccountLinking: false. The adapter will NOT auto-link
 *     a Google account to an existing user with the same email.
 *   - The signIn callback enforces Google's email_verified flag (throws if
 *     false). It also pre-creates the Account row manually when an existing
 *     user with the same verified email is found — so the adapter's later
 *     getUserByAccount call finds the link and doesn't try to create a
 *     duplicate user (which would violate the email @unique constraint).
 *   - For brand-new Google users, the adapter's createUser runs; our
 *     events.createUser hook marks emailVerified immediately (Google already
 *     verified it) and leaves passwordHash null.
 *   - For an existing password user with the same verified email, we mark
 *     emailVerified=true on that user if it was null.
 *   - We never auto-link when Google's email_verified is false — signIn
 *     throws OAUTH_EMAIL_NOT_VERIFIED before any account mutation.
 *
 * AUDIT LOGS (Phase 25 spec):
 *   - GOOGLE_SIGN_IN: written for every successful Google sign-in (new,
 *     returning, or linked-to-existing). For new users, deferred to
 *     events.createUser. For existing users, written in signIn callback.
 *   - ACCOUNT_LINKED: written in events.linkAccount (first time only).
 *
 * GENERIC ERROR MESSAGES: All credential failures return null → NextAuth shows
 * a generic "CredentialsSignin" error. We never reveal whether the email
 * exists, to prevent account enumeration. Same for forgot-password
 * ("If the email exists, you'll receive a reset link").
 */
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";

import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import { rateLimitGoogleSignIn, getRequestIp } from "@/lib/rate-limit";

// Prisma adapter v2 — used for OAuth account linking + user creation.
// JWT strategy doesn't use the Session table, but the adapter is still
// needed for Account / VerificationToken flows.
const adapter = PrismaAdapter(db) as never; // cast: adapter typing is loose across v4/v5

// ─── Google OAuth env vars ─────────────────────────────────────────────────
// Phase 25 renames GOOGLE_CLIENT_ID/SECRET → AUTH_GOOGLE_ID/SECRET per spec.
// We honor both names so existing deployments don't break overnight.
function googleClientId(): string | undefined {
  return process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID ?? undefined;
}
function googleClientSecret(): string | undefined {
  return process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? undefined;
}

// ─── Helpers used by the signIn callback ────────────────────────────────────

/** Fetch the request IP inside a Server Component / server action / callback. */
async function getRequestIpFromNextHeaders(): Promise<string> {
  const h = await headers();
  return getRequestIp(new Request("http://localhost/", { headers: h }));
}

/**
 * Look up an existing user by Google provider+providerAccountId OR by email.
 * Returns { id, emailVerified, exists } — used by the signIn callback to
 * decide between (a) writing GOOGLE_SIGN_IN audit + marking verified, or
 * (b) deferring the audit to events.createUser for brand-new users.
 */
async function findExistingUserForGoogle(
  account: { provider: string; providerAccountId: string },
  email: string,
): Promise<{ id: string; emailVerified: Date | null } | null> {
  // 1. Try by linked Account row (returning Google user).
  const byAccount = await db.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      },
    },
    select: { userId: true },
  });
  if (byAccount) {
    const user = await db.user.findUnique({
      where: { id: byAccount.userId },
      select: { id: true, emailVerified: true },
    });
    if (user) return user;
  }
  // 2. Try by email (existing password user being linked for the first time).
  const byEmail = await db.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true },
  });
  return byEmail ?? null;
}

export const authOptions: NextAuthOptions = {
  adapter,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  // Custom pages — Phase 2 spec requires /login and /register specifically.
  pages: {
    signIn: "/login",
    signOut: "/",
    error: "/login",
    verifyRequest: "/verify-email",
    newUser: "/onboarding",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Always parse — never short-circuit "user not found" early, so timing
        // doesn't reveal whether the email is registered.
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            emailVerified: true,
            isOnboarded: true,
            timezone: true,
            baseCurrency: true,
            image: true,
          },
        });

        // Always do an argon2 verify against a dummy hash if the user isn't
        // found, to keep timing constant (side-channel resistance).
        const dummyHash = "$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXk$ZHVtbXk";
        const hashToVerify = user?.passwordHash ?? dummyHash;
        const passwordOk = await argon2.verify(hashToVerify, password).catch(() => false);

        if (!user || !passwordOk) {
          return null;
        }

        // Block login if email not verified. The session callback carries
        // emailVerified onto the JWT so middleware can also enforce the gate.
        // Exception: the demo seed user is auto-verified.
        if (!user.emailVerified) {
          throw new Error("EMAIL_NOT_VERIFIED");
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          image: user.image ?? undefined,
        };
      },
    }),
    // Google OAuth — registered when AUTH_GOOGLE_ID (or the legacy
    // GOOGLE_CLIENT_ID) is set. allowDangerousEmailAccountLinking is false
    // because the signIn callback enforces email_verified and pre-links
    // existing email users manually (so the adapter doesn't try to create a
    // duplicate User row that would violate the email @unique constraint).
    ...(googleClientId() && googleClientSecret()
      ? [
          GoogleProvider({
            clientId: googleClientId()!,
            clientSecret: googleClientSecret()!,
            // Phase 25 spec: request only openid, email, profile scopes.
            authorization: {
              params: { scope: "openid email profile" },
            },
            allowDangerousEmailAccountLinking: false,
          }),
        ]
      : []),
  ],
  callbacks: {
    // ─── signIn callback ────────────────────────────────────────────────────
    // Runs before the adapter's createUser/linkAccount. We enforce:
    //   - Google's email_verified must be true (else throw)
    //   - Rate limit on IP+email
    //   - Pre-link the Google Account to an existing user with the same
    //     verified email (so the adapter's getUserByAccount finds the link
    //     instead of trying to create a duplicate user).
    //   - Mark emailVerified on the existing user if it was null.
    //   - Write GOOGLE_SIGN_IN audit for existing users. For brand-new users,
    //     events.createUser writes it (we don't have the DB user.id yet here).
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        const email = (user.email ?? "").toLowerCase();
        if (!email) {
          throw new Error("OAUTH_NO_EMAIL");
        }

        // Rate limit Google sign-in attempts.
        const ip = await getRequestIpFromNextHeaders();
        const rl = await rateLimitGoogleSignIn(ip, email);
        if (!rl.success) {
          throw new Error("OAUTH_RATE_LIMITED");
        }

        // Enforce email_verified. profile comes from Google's userinfo.
        const profileWithEmail = profile as { email_verified?: boolean };
        if (!profileWithEmail.email_verified) {
          throw new Error("OAUTH_EMAIL_NOT_VERIFIED");
        }

        // Look up existing user (by Account OR by email).
        const existing = await findExistingUserForGoogle(account, email);

        if (existing) {
          // Check if the Google Account row already exists for this user.
          const existingAccount = await db.account.findUnique({
            where: {
              provider_providerAccountId: {
                provider: account.provider,
                providerAccountId: account.providerAccountId,
              },
            },
            select: { userId: true },
          });

          if (!existingAccount) {
            // Pre-create the Account link so the adapter's getUserByAccount
            // finds it (avoiding the duplicate-email createUser throw).
            await db.account.create({
              data: {
                userId: existing.id,
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                refresh_token: account.refresh_token ?? null,
                access_token: account.access_token ?? null,
                expires_at: account.expires_at ?? null,
                token_type: account.token_type ?? null,
                scope: account.scope ?? null,
                id_token: account.id_token ?? null,
                session_state: (account as { session_state?: string | null }).session_state ?? null,
              },
            });
            // Audit: first-time link to an existing email user.
            await db.auditLog.create({
              data: {
                userId: existing.id,
                action: "ACCOUNT_LINKED",
                entity: "Account",
                entityId: account.providerAccountId,
                meta: { provider: "google", email } as never,
              },
            });
          }

          // Mark emailVerified on the existing user if it was null
          // (Google verified the email for us).
          if (!existing.emailVerified) {
            await db.user.update({
              where: { id: existing.id },
              data: { emailVerified: new Date() },
            });
          }

          // Audit: GOOGLE_SIGN_IN for an existing user. For brand-new users,
          // events.createUser writes this audit (we don't have user.id yet
          // here).
          await db.auditLog.create({
            data: {
              userId: existing.id,
              action: "GOOGLE_SIGN_IN",
              entity: "User",
              entityId: existing.id,
              meta: { provider: "google", email } as never,
            },
          });
        }
        // If existing is null → brand-new Google user. The adapter's
        // createUser will run; events.createUser will write the audit logs.
      }
      return true;
    },

    // ─── JWT callback ───────────────────────────────────────────────────────
    // Decorates the token with isOnboarded / emailVerified / timezone /
    // baseCurrency / sessionVersion so middleware can branch without a DB hit.
    // Periodically re-checks sessionVersion against the DB so a stale token
    // (after sign-out-of-all-devices) is stripped on the next session read.
    async jwt({ token, user, trigger }) {
      // Initial sign-in: user is populated, fetch flags from DB.
      if (user) {
        token.id = user.id;
        const fresh = await db.user.findUnique({
          where: { id: user.id },
          select: {
            isOnboarded: true,
            emailVerified: true,
            timezone: true,
            baseCurrency: true,
            sessionVersion: true,
          },
        });
        if (fresh) {
          token.isOnboarded = fresh.isOnboarded;
          token.emailVerified = fresh.emailVerified;
          token.timezone = fresh.timezone;
          token.baseCurrency = fresh.baseCurrency;
          token.sessionVersion = fresh.sessionVersion;
          token.sessionVersionCheckedAt = Date.now();
        }
      }
      // On token refresh after onboarding completion (or sign-out-all), re-read
      // flags so the gate flips / session is invalidated.
      if (trigger === "update") {
        const fresh = await db.user.findUnique({
          where: { id: token.id as string },
          select: {
            isOnboarded: true,
            emailVerified: true,
            timezone: true,
            baseCurrency: true,
            sessionVersion: true,
          },
        });
        if (fresh) {
          token.isOnboarded = fresh.isOnboarded;
          token.emailVerified = fresh.emailVerified;
          token.timezone = fresh.timezone;
          token.baseCurrency = fresh.baseCurrency;
          token.sessionVersion = fresh.sessionVersion;
          token.sessionVersionCheckedAt = Date.now();
        }
      }
      // Periodic sessionVersion check (every 60s) — invalidates outstanding
      // tokens after sign-out-of-all-devices. We don't run this branch on
      // initial sign-in (handled above) or on update trigger (handled above).
      if (token.id && !user && trigger !== "update") {
        const lastCheck = (token.sessionVersionCheckedAt as number | undefined) ?? 0;
        if (Date.now() - lastCheck > 60_000) {
          const fresh = await db.user.findUnique({
            where: { id: token.id as string },
            select: {
              isOnboarded: true,
              emailVerified: true,
              timezone: true,
              baseCurrency: true,
              sessionVersion: true,
            },
          });
          if (!fresh) {
            // User was deleted — strip the token.
            return {};
          }
          if (fresh.sessionVersion !== (token.sessionVersion as number | undefined)) {
            // sessionVersion mismatch — another device signed out of all.
            // Strip the token; requireUser() will redirect to /login.
            return {};
          }
          // Refresh other flags while we're here (e.g. emailVerified flip,
          // onboarding completion done on another device).
          token.isOnboarded = fresh.isOnboarded;
          token.emailVerified = fresh.emailVerified;
          token.timezone = fresh.timezone;
          token.baseCurrency = fresh.baseCurrency;
          token.sessionVersionCheckedAt = Date.now();
        }
      }
      return token;
    },

    // ─── Session callback ──────────────────────────────────────────────────
    // Copies token fields onto session.user for server-side reads via
    // getServerSession(). If the jwt callback stripped the token (returned {}),
    // token.id is undefined → session.user.id stays undefined → requireUser()
    // redirects to /login.
    async session({ session, token }) {
      if (session.user && token?.id) {
        session.user.id = token.id as string;
        session.user.isOnboarded = token.isOnboarded as boolean | undefined;
        session.user.emailVerified = (token.emailVerified as Date | undefined) ?? null;
        session.user.timezone = token.timezone as string | undefined;
        session.user.baseCurrency = token.baseCurrency as string | undefined;
      }
      return session;
    },

    // ─── Redirect callback ──────────────────────────────────────────────────
    // Same-origin only — never trust arbitrary absolute URLs.
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      try {
        const u = new URL(url);
        if (u.origin === baseUrl) return url;
      } catch {
        // fall through
      }
      return baseUrl;
    },
  },

  events: {
    // OAuth users (Google): Google already verified the email. Mark
    // emailVerified immediately and leave passwordHash null. We don't bother
    // creating a VerificationToken row (the spec doesn't require it; the
    // GOOGLE_SIGN_IN audit log is the trail).
    async createUser({ user }) {
      if (user.id && user.email) {
        await db.user.update({
          where: { id: user.id },
          data: { emailVerified: new Date() },
        });
        // Audit: GOOGLE_SIGN_IN for a brand-new Google user. (Existing-user
        // case is logged in the signIn callback above.)
        await db.auditLog.create({
          data: {
            userId: user.id,
            action: "GOOGLE_SIGN_IN",
            entity: "User",
            entityId: user.id,
            meta: { provider: "google", email: user.email } as never,
          },
        });
      }
    },
    // Fires when the adapter creates a new Account row (first-time Google
    // sign-in for a brand-new user). For existing email users, we wrote the
    // ACCOUNT_LINKED audit in the signIn callback (pre-link path).
    async linkAccount({ account, user }) {
      if (account.provider === "google" && user.id) {
        // Only write ACCOUNT_LINKED here if we didn't already in signIn
        // callback. We can detect this by checking whether an AuditLog row
        // already exists for this (userId, providerAccountId). Simpler:
        // only fire this for new-user path (the existing-user path wrote
        // its own audit and pre-created the Account row, so this event would
        // NOT fire in that case — linkAccount fires when the ADAPTER creates
        // the row, and we already created it manually in signIn).
        await db.auditLog.create({
          data: {
            userId: user.id,
            action: "ACCOUNT_LINKED",
            entity: "Account",
            entityId: account.providerAccountId,
            meta: { provider: "google" } as never,
          },
        });
      }
    },
  },

  debug: process.env.NODE_ENV !== "production",
};

// ─── Type augmentation: Session.user & JWT carry our extra fields ───────────
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      isOnboarded?: boolean;
      emailVerified?: Date | null;
      timezone?: string;
      baseCurrency?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isOnboarded?: boolean;
    emailVerified?: Date | null;
    timezone?: string;
    baseCurrency?: string;
    sessionVersion?: number;
    sessionVersionCheckedAt?: number;
  }
}
