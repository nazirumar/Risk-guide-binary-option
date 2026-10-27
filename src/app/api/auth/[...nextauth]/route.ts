import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// NextAuth v4 route handler — mounted at /api/auth/[...nextauth].
// Handles /api/auth/signin, /api/auth/callback/*, /api/auth/session, etc.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
