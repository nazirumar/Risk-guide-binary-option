-- Phase 25: add sessionVersion Int @default(0) to User for JWT invalidation
-- (sign out of all devices). The jwt callback in src/lib/auth.ts re-reads this
-- periodically and strips the token if it doesn't match.

-- SQLite
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
