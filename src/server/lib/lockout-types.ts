/**
 * Lockout types — kept outside the "use server" file because Next.js 16's
 * Turbopack requires "use server" files to export ONLY async functions.
 * Type exports in "use server" files are flagged as "found object" errors.
 */

export type LockoutResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  lockoutId?: string;
};

export type BreachCheckResult = {
  lockoutCreated: boolean;
  reason?: "DAILY_LOSS" | "CONSEC_LOSSES" | "WEEKLY_LOSS";
  expiresAt?: Date;
  message?: string;
};
