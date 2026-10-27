/**
 * RiskGuard Prisma client singleton.
 *
 * Re-exports the typed `db` instance so every server module imports from one
 * place: `import { db } from "@/lib/db"`. Per PROJECT_RULES.md rule #3, every
 * query must be scoped by userId — this file is the single chokepoint where
 * Prisma is constructed, so future cross-cutting concerns (logging middleware,
 * userId enforcement helpers, slow-query alerts) can be added here.
 *
 * Singleton pattern avoids exhausting the connection pool during Next.js hot
 * reloads in dev.
 */
import { PrismaClient } from "@prisma/client";

// Strict query logger — surfaces slow queries in dev. Off in production.
const log: ("query" | "error" | "warn" | "info")[] =
  process.env.NODE_ENV === "production" ? ["error", "warn"] : ["error", "warn"];

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// Re-export the generated Prisma types so callers can do
// `import { db, type Trade } from "@/lib/db"` in one statement.
export type { Trade, TradingAccount, RiskProfile, StakingPlan, User } from "@prisma/client";
