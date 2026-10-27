/**
 * Active-account cookie name (constant). Kept in a non-"use server" module
 * so it can be imported from anywhere — server-action files can only export
 * async functions, so constants live here.
 */
export const ACTIVE_ACCOUNT_COOKIE = "riskguard-active-account";
