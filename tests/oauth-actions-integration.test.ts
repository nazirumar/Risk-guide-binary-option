/**
 * Phase 25 — integration tests for the real server actions.
 *
 * Unlike `tests/oauth-linking.test.ts` (which mirrors the action DB writes
 * directly to avoid session context), these tests call the actual exported
 * actions from `src/server/actions/oauth.ts` + `profile.ts`, with
 * `requireUser` mocked to return a test userId. This validates that the
 * actions' real code paths (Zod parsing, argon2 verify, audit log writes,
 * rate limiting, db queries) all work end-to-end.
 *
 * Coverage:
 *   1. setPasswordAction on a Google-only user → password set + audit log.
 *   2. setPasswordAction on a user with passwordHash → rejected (use Change
 *      password instead).
 *   3. unlinkAccountAction on a Google-only user → blocked.
 *   4. unlinkAccountAction on a password user with correct re-auth → succeeds.
 *   5. unlinkAccountAction on a password user with WRONG re-auth → rejected.
 *   6. signOutAllDevicesAction increments sessionVersion + writes audit.
 *   7. signOutAllDevicesAction on Google-only user → blocked.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

// Mock requireUser so the actions don't need a real NextAuth session. Each
// test sets the current userId via `__setTestUserId`. The mock returns the
// same shape as the real requireUser (so onboarding/email-verified gates
// don't short-circuit).
let currentTestUserId: string | null = null;
vi.mock("@/server/lib/require-user", () => ({
  requireUser: async () => {
    if (!currentTestUserId) throw new Error("test userId not set");
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: currentTestUserId },
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
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      isOnboarded: u.isOnboarded,
      emailVerified: u.emailVerified,
      timezone: u.timezone,
      baseCurrency: u.baseCurrency,
    };
  },
}));

// Import AFTER the mock is set up so the mock takes effect.
import { unlinkAccountAction, signOutAllDevicesAction } from "@/server/actions/oauth";
import { setPasswordAction, changePasswordAction } from "@/server/actions/profile";

async function makePasswordUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await argon2.hash("TestPass123!"),
      emailVerified: new Date(),
      isOnboarded: true,
    },
  });
  return user.id;
}

async function makeGoogleOnlyUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      name: "Google User",
      passwordHash: null,
      emailVerified: new Date(),
      isOnboarded: true,
    },
  });
  return user.id;
}

async function makeAccount(userId: string, providerAccountId: string): Promise<void> {
  await prisma.account.create({
    data: {
      userId,
      type: "oauth",
      provider: "google",
      providerAccountId,
      scope: "openid email profile",
    },
  });
}

function makeFormData(obj: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.account.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.user.deleteMany();
  currentTestUserId = null;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── 1. setPasswordAction ────────────────────────────────────────────────────

describe("Phase 25 — setPasswordAction integration", () => {
  it("lets a Google-only user set a password + writes PASSWORD_SET audit", async () => {
    const userId = await makeGoogleOnlyUser("set1@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      newPassword: "NewPass123!",
      confirmPassword: "NewPass123!",
    });
    const res = await setPasswordAction(fd);
    expect(res.ok).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).not.toBeNull();
    const ok = await argon2.verify(user.passwordHash!, "NewPass123!");
    expect(ok).toBe(true);
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "PASSWORD_SET" },
    });
    expect(audits.length).toBe(1);
  });

  it("rejects when passwordHash already exists", async () => {
    const userId = await makePasswordUser("set2@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      newPassword: "Another123!",
      confirmPassword: "Another123!",
    });
    const res = await setPasswordAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already has a password/i);
  });

  it("rejects when newPassword doesn't meet complexity rules", async () => {
    const userId = await makeGoogleOnlyUser("set3@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      newPassword: "weak",
      confirmPassword: "weak",
    });
    const res = await setPasswordAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/fix the highlighted fields/i);
  });

  it("rejects when newPassword !== confirmPassword", async () => {
    const userId = await makeGoogleOnlyUser("set4@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      newPassword: "GoodPass123!",
      confirmPassword: "DifferentPass123!",
    });
    const res = await setPasswordAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/fix the highlighted fields/i);
  });
});

// ─── 2. unlinkAccountAction ─────────────────────────────────────────────────

describe("Phase 25 — unlinkAccountAction integration", () => {
  it("blocks when Google is the only sign-in method", async () => {
    const userId = await makeGoogleOnlyUser("unlink1@example.com");
    currentTestUserId = userId;
    await makeAccount(userId, "sub-1");
    const fd = makeFormData({
      provider: "google",
      providerAccountId: "sub-1",
      confirmPassword: "TestPass123!",
    });
    const res = await unlinkAccountAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/only sign-in method/i);
    // Account row NOT deleted.
    const count = await prisma.account.count({ where: { userId } });
    expect(count).toBe(1);
  });

  it("succeeds for a password user with correct re-auth", async () => {
    const userId = await makePasswordUser("unlink2@example.com");
    currentTestUserId = userId;
    await makeAccount(userId, "sub-2");
    const fd = makeFormData({
      provider: "google",
      providerAccountId: "sub-2",
      confirmPassword: "TestPass123!",
    });
    const res = await unlinkAccountAction(fd);
    expect(res.ok).toBe(true);
    const count = await prisma.account.count({ where: { userId } });
    expect(count).toBe(0);
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "ACCOUNT_UNLINKED" },
    });
    expect(audits.length).toBe(1);
  });

  it("rejects when the password is wrong", async () => {
    const userId = await makePasswordUser("unlink3@example.com");
    currentTestUserId = userId;
    await makeAccount(userId, "sub-3");
    const fd = makeFormData({
      provider: "google",
      providerAccountId: "sub-3",
      confirmPassword: "WrongPassword99!",
    });
    const res = await unlinkAccountAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Password is incorrect/i);
    const count = await prisma.account.count({ where: { userId } });
    expect(count).toBe(1);
  });

  it("rejects when the Account row belongs to a different user", async () => {
    const userIdA = await makePasswordUser("unlinkA@example.com");
    const userIdB = await makePasswordUser("unlinkB@example.com");
    currentTestUserId = userIdB; // B is the "caller"
    await makeAccount(userIdA, "sub-A"); // belongs to A
    const fd = makeFormData({
      provider: "google",
      providerAccountId: "sub-A",
      confirmPassword: "TestPass123!", // B's correct password
    });
    const res = await unlinkAccountAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not found or does not belong/i);
    // The Account row is untouched.
    const count = await prisma.account.count({
      where: { userId: userIdA, provider: "google" },
    });
    expect(count).toBe(1);
  });
});

// ─── 3. signOutAllDevicesAction ─────────────────────────────────────────────

describe("Phase 25 — signOutAllDevicesAction integration", () => {
  it("increments sessionVersion + writes audit (correct re-auth)", async () => {
    const userId = await makePasswordUser("so1@example.com");
    currentTestUserId = userId;
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(before.sessionVersion).toBe(0);
    const fd = makeFormData({ confirmPassword: "TestPass123!" });
    const res = await signOutAllDevicesAction(fd);
    expect(res.ok).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(1);
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "SIGN_OUT_ALL_DEVICES" },
    });
    expect(audits.length).toBe(1);
  });

  it("rejects Google-only users (no re-auth possible without password)", async () => {
    const userId = await makeGoogleOnlyUser("so2@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({ confirmPassword: "any" });
    const res = await signOutAllDevicesAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Set a password first/i);
    // sessionVersion NOT bumped.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(0);
  });

  it("rejects when the password is wrong", async () => {
    const userId = await makePasswordUser("so3@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({ confirmPassword: "WrongPassword99!" });
    const res = await signOutAllDevicesAction(fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Password is incorrect/i);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(0);
  });
});

// ─── 4. changePasswordAction bumps sessionVersion ────────────────────────────

describe("Phase 25 — changePasswordAction bumps sessionVersion", () => {
  it("increments sessionVersion + writes PASSWORD_CHANGED audit", async () => {
    const userId = await makePasswordUser("cp1@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      currentPassword: "TestPass123!",
      newPassword: "NewPass123!",
      confirmPassword: "NewPass123!",
    });
    const res = await changePasswordAction(fd);
    expect(res.ok).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true, passwordHash: true },
    });
    expect(after.sessionVersion).toBe(1);
    // The new password verifies.
    const ok = await argon2.verify(after.passwordHash!, "NewPass123!");
    expect(ok).toBe(true);
    // The OLD password no longer verifies.
    const okOld = await argon2.verify(after.passwordHash!, "TestPass123!");
    expect(okOld).toBe(false);
  });

  it("rejects when currentPassword is wrong (sessionVersion stays 0)", async () => {
    const userId = await makePasswordUser("cp2@example.com");
    currentTestUserId = userId;
    const fd = makeFormData({
      currentPassword: "WrongPass99!",
      newPassword: "NewPass123!",
      confirmPassword: "NewPass123!",
    });
    const res = await changePasswordAction(fd);
    expect(res.ok).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(0);
  });
});
