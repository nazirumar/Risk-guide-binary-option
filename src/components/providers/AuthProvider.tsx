"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Client-only wrapper for next-auth's SessionProvider. Required because
 * SessionProvider uses React context, which is unavailable in server
 * components. The root layout (server component) renders this wrapper so
 * `useSession()` works in any client component under the tree.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
