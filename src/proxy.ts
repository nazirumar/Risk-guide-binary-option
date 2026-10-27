/**
 * RiskGuard proxy (formerly middleware — Next.js 16 renamed the file
 * convention from `middleware.ts` to `proxy.ts`). Protects authed routes and
 * nudges incomplete users to the right gate.
 *
 *   - /app/*                    → must have a token (any authed user)
 *   - /app/* (except onboarding) → if not onboarded, redirect to /onboarding
 *   - /onboarding           → if already onboarded + verified, redirect to /app/dashboard
 *   - /login, /register, /forgot-password → redirect to /app/dashboard if authed
 *   - everything else           → public
 *
 * Note: `withAuth`'s `authorized` callback only returns true/false; it can't
 * redirect. So we return true for any authed user on /app/* (even un-onboarded
 * ones), then do the redirect in the middleware body.
 */
import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

const AUTH_PAGES = new Set(["/login", "/register", "/forgot-password"]);
const PUBLIC_AUTHED_OK = new Set(["/verify-email", "/reset-password"]);
const ONBOARDING_PATH = "/onboarding";

export default withAuth(
  function middleware(req) {
    const path = req.nextUrl.pathname;
    const token = req.nextauth.token;

    if (!token) return NextResponse.next();

    const isOnboarded = Boolean((token as { isOnboarded?: boolean }).isOnboarded);
    const emailVerified = (token as { emailVerified?: Date | null }).emailVerified;

    // Authed users hitting /login /register /forgot-password → bounce to /app/dashboard
    // (or /onboarding if not done yet).
    if (AUTH_PAGES.has(path)) {
      if (!emailVerified) return NextResponse.next(); // let them re-verify
      return NextResponse.redirect(
        new URL(isOnboarded ? "/app/dashboard" : "/onboarding", req.url),
      );
    }

    // Already onboarded + verified users hitting /onboarding → send to dashboard.
    if (path === ONBOARDING_PATH && isOnboarded && emailVerified) {
      return NextResponse.redirect(new URL("/app/dashboard", req.url));
    }

    // Un-onboarded users hitting /app/* → force to onboarding.
    if (path.startsWith("/app") && (!isOnboarded || !emailVerified)) {
      return NextResponse.redirect(new URL(ONBOARDING_PATH, req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      // Allow through if there's a token, OR if the path is public / an auth page.
      authorized: ({ token, req }) => {
        const path = req.nextUrl.pathname;
        // Public paths — anyone can visit, including no token.
        if (path === "/" || PUBLIC_AUTHED_OK.has(path)) return true;
        // Auth pages — allow through (middleware body redirects authed users).
        if (AUTH_PAGES.has(path)) return true;
        // Everything under /app/* AND /onboarding requires a token.
        if (path.startsWith("/app") || path === ONBOARDING_PATH) {
          return Boolean(token);
        }
        // API routes handle their own auth.
        return true;
      },
    },
    pages: {
      signIn: "/login",
    },
  },
);

// Skip middleware for static assets and NextAuth internals.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.svg|robots.txt|api/auth).*)"],
};
