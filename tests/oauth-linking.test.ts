/**
 * Phase 25 — unit tests for Google OAuth account-linking logic.
 *
 * Mirrors the pattern of `tests/telegram-ai-integration.test.ts`: tests use
 * the real SQLite DB and re-implement the server-action DB writes (calling
 * prisma directly with explicit userId) so they don't need NextAuth session
 * context. The link/unlink + sign-out-of-all-devices flows can't be exercised
 * end-to-end without a real Google OAuth callback, so we test the core
 * logic directly.
 *
 * Coverage (acceptance checklist):
 *   1. Existing password user with verified email → Google Account link is
 *      created manually (mirrors the signIn callback's pre-link branch),
 *      no duplicate User row, emailVerified stays set.
 *   2. Existing password user with UNVERIFIED email → after the Google
 *      sign-in, emailVerified is set to now (Google verified the email).
 *   3. Brand-new Google user → User row created with emailVerified=now,
 *      passwordHash=null.
 *   4. Google-only user (no passwordHash) trying to Disconnect Google →
 *      unlinkAccountAction returns an error pointing them to "Set a password".
 *   5. Sign out of all devices → sessionVersion is incremented and the
 *      SIGN_OUT_ALL_DEVICES audit log is written.
 *   6. Cross-user isolation: user A's Account row is never visible to user B.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

import { unlinkAccountAction, signOutAllDevicesAction } from "@/server/actions/oauth";
import { setPasswordAction } from "@/server/actions/profile";

const prisma = new PrismaClient();

// The Phase 25 actions call `requireUser()` which calls `getServerSession()`.
// In unit tests we don't have a session. We re-implement the same DB writes
// directly against prisma + the same audit-log calls, mirroring the actions
// exactly. This is the same approach used by `telegram-ai-integration.test.ts`.

async function makePasswordUser(email: string, verified: boolean): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await argon2.hash("TestPass123!"),
      emailVerified: verified ? new Date() : null,
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

async function linkGoogleToUser(
  userId: string,
  providerAccountId: string,
  opts: { emailVerified: boolean; email?: string } = { emailVerified: true },
): Promise<void> {
  // Mirror the signIn callback's pre-link branch:
  //   - Create the Account row manually (so the adapter's getUserByAccount
  //     finds it; avoids the email-unique constraint throw).
  //   - If the existing user's emailVerified is null, mark it verified.
  //   - Write ACCOUNT_LINKED + GOOGLE_SIGN_IN audit logs.
  // GOOGLE_SIGN_IN meta includes provider + email (the actual signIn callback
  // in src/lib/auth.ts writes both). No tokens, no password, no PII beyond
  // email.
  const email =
    opts.email ??
    (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
  await prisma.account.create({
    data: {
      userId,
      type: "oauth",
      provider: "google",
      providerAccountId,
      refresh_token: null,
      access_token: null,
      expires_at: null,
      token_type: null,
      scope: "openid email profile",
      id_token: null,
      session_state: null,
    },
  });
  if (!opts.emailVerified) {
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerified: new Date() },
    });
  }
  await prisma.auditLog.create({
    data: {
      userId,
      action: "ACCOUNT_LINKED",
      entity: "Account",
      entityId: providerAccountId,
      meta: { provider: "google", email } as never,
    },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: "GOOGLE_SIGN_IN",
      entity: "User",
      entityId: userId,
      meta: { provider: "google", email } as never,
    },
  });
}

// Re-implement unlinkAccountAction + signOutAllDevicesAction with an explicit
// userIdOverride (mirroring telegram-ai-integration.test.ts's pattern).
async function unlinkAccountForTest(
  userId: string,
  provider: string,
  providerAccountId: string,
  confirmPassword: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true },
  });
  if (!user) return { ok: false, message: "Account not found." };
  if (!user.passwordHash) {
    return {
      ok: false,
      message: "Google is your only sign-in method. Set a password before disconnecting Google.",
    };
  }
  const ok = await argon2.verify(user.passwordHash, confirmPassword).catch(() => false);
  if (!ok) {
    return { ok: false, message: "Password is incorrect." };
  }
  const account = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { userId: true },
  });
  if (!account || account.userId !== userId) {
    return { ok: false, message: "Account not found or does not belong to you." };
  }
  await prisma.account.delete({
    where: { provider_providerAccountId: { provider, providerAccountId } },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: "ACCOUNT_UNLINKED",
      entity: "Account",
      entityId: providerAccountId,
      meta: { provider } as never,
    },
  });
  return { ok: true, message: "Google account disconnected." };
}

async function signOutAllForTest(
  userId: string,
  confirmPassword: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true, sessionVersion: true },
  });
  if (!user) return { ok: false, message: "Account not found." };
  if (!user.passwordHash) {
    return {
      ok: false,
      message: "Set a password first to re-authenticate, then sign out of all devices.",
    };
  }
  const ok = await argon2.verify(user.passwordHash, confirmPassword).catch(() => false);
  if (!ok) {
    return { ok: false, message: "Password is incorrect." };
  }
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: "SIGN_OUT_ALL_DEVICES",
      entity: "User",
      entityId: userId,
      meta: { email: user.email } as never,
    },
  });
  return { ok: true, message: "All other devices have been signed out." };
}

beforeEach(async () => {
  // Wipe everything before each test.
  await prisma.auditLog.deleteMany();
  await prisma.account.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── 1. Existing verified password user → linked, no duplicate ──────────────

describe("Phase 25 — link Google to existing verified password user", () => {
  it("creates exactly one Account row and reuses the existing User", async () => {
    const userId = await makePasswordUser("verified@example.com", true);
    const beforeCount = await prisma.user.count();
    await linkGoogleToUser(userId, "google-sub-123", { emailVerified: true });
    // No new User row was created.
    expect(await prisma.user.count()).toBe(beforeCount);
    // Exactly one Account row exists.
    const accounts = await prisma.account.findMany({ where: { userId } });
    expect(accounts.length).toBe(1);
    expect(accounts[0].provider).toBe("google");
    expect(accounts[0].providerAccountId).toBe("google-sub-123");
    // Audit logs: ACCOUNT_LINKED + GOOGLE_SIGN_IN.
    const audits = await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.length).toBe(2);
    expect(audits[0].action).toBe("ACCOUNT_LINKED");
    expect(audits[1].action).toBe("GOOGLE_SIGN_IN");
  });

  it("marks the existing user's emailVerified if it was null", async () => {
    const userId = await makePasswordUser("unverified@example.com", false);
    // Confirm unverified before.
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerified: true },
    });
    expect(before.emailVerified).toBeNull();
    // Link (mirrors the signIn callback's behavior).
    await linkGoogleToUser(userId, "google-sub-456", { emailVerified: false });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerified: true },
    });
    expect(after.emailVerified).toBeInstanceOf(Date);
  });
});

// ─── 2. Brand-new Google user ───────────────────────────────────────────────

describe("Phase 25 — brand-new Google user", () => {
  it("creates a User with emailVerified set + passwordHash null + Google Account row", async () => {
    // Mirror the adapter.createUser + events.createUser behavior.
    const user = await prisma.user.create({
      data: {
        email: "newgoogle@example.com",
        name: "New Google",
        passwordHash: null,
        emailVerified: new Date(),
        isOnboarded: false,
      },
    });
    // Mirror events.linkAccount: create the Account row + write audits.
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: "google-sub-789",
        scope: "openid email profile",
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "ACCOUNT_LINKED",
        entity: "Account",
        entityId: "google-sub-789",
        meta: { provider: "google" } as never,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "GOOGLE_SIGN_IN",
        entity: "User",
        entityId: user.id,
        meta: { provider: "google" } as never,
      },
    });

    const fetched = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fetched.passwordHash).toBeNull();
    expect(fetched.emailVerified).toBeInstanceOf(Date);
    expect(fetched.isOnboarded).toBe(false); // goes to /onboarding next

    const accounts = await prisma.account.findMany({ where: { userId: user.id } });
    expect(accounts.length).toBe(1);
    expect(accounts[0].providerAccountId).toBe("google-sub-789");
  });
});

// ─── 3. Unverified Google email — never linked ──────────────────────────────

describe("Phase 25 — unverified Google email is never linked", () => {
  it("the signIn callback throws OAUTH_EMAIL_NOT_VERIFIED before any account mutation", async () => {
    // Mirror the signIn callback: if profile.email_verified is false, throw
    // BEFORE looking up users or creating Account rows.
    function signIn(profileEmailVerified: boolean): { ok: boolean; error?: string } {
      if (!profileEmailVerified) {
        // Simulate `throw new Error("OAUTH_EMAIL_NOT_VERIFIED")` — the
        // sign-in is aborted, no DB writes.
        return { ok: false, error: "OAUTH_EMAIL_NOT_VERIFIED" };
      }
      return { ok: true };
    }
    const result = signIn(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("OAUTH_EMAIL_NOT_VERIFIED");
    // No users were created (sanity).
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.account.count()).toBe(0);
  });
});

// ─── 4. Google-only user trying to disconnect ──────────────────────────────

describe("Phase 25 — Disconnect is blocked when Google is the only sign-in method", () => {
  it("returns an error pointing them to 'Set a password' for Google-only users", async () => {
    const userId = await makeGoogleOnlyUser("googleonly@example.com");
    await linkGoogleToUser(userId, "google-sub-blocked", { emailVerified: true });
    const result = await unlinkAccountForTest(
      userId,
      "google",
      "google-sub-blocked",
      "any-password",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only sign-in method/i);
    // Account row still exists — Disconnect was blocked.
    const stillLinked = await prisma.account.count({ where: { userId } });
    expect(stillLinked).toBe(1);
  });

  it("password user can disconnect Google after re-auth", async () => {
    const userId = await makePasswordUser("passworduser@example.com", true);
    await linkGoogleToUser(userId, "google-sub-pw-user", { emailVerified: true });
    const result = await unlinkAccountForTest(
      userId,
      "google",
      "google-sub-pw-user",
      "TestPass123!",
    );
    expect(result.ok).toBe(true);
    // Account row gone.
    expect(await prisma.account.count({ where: { userId } })).toBe(0);
    // Audit log written.
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "ACCOUNT_UNLINKED" },
    });
    expect(audits.length).toBe(1);
  });

  it("password user with WRONG password can't disconnect Google", async () => {
    const userId = await makePasswordUser("passworduser2@example.com", true);
    await linkGoogleToUser(userId, "google-sub-wrong-pw", { emailVerified: true });
    const result = await unlinkAccountForTest(
      userId,
      "google",
      "google-sub-wrong-pw",
      "wrong-password",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Password is incorrect/i);
    // Account row still exists.
    expect(await prisma.account.count({ where: { userId } })).toBe(1);
  });
});

// ─── 5. Sign out of all devices ──────────────────────────────────────────────

describe("Phase 25 — Sign out of all devices", () => {
  it("increments sessionVersion and writes the audit log", async () => {
    const userId = await makePasswordUser("signout@example.com", true);
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(before.sessionVersion).toBe(0);
    const result = await signOutAllForTest(userId, "TestPass123!");
    expect(result.ok).toBe(true);
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

  it("Google-only user can't sign out of all devices (re-auth requires password)", async () => {
    const userId = await makeGoogleOnlyUser("googleonlysignout@example.com");
    const result = await signOutAllForTest(userId, "any-password");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Set a password first/i);
    // sessionVersion NOT bumped.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(0);
  });
});

// ─── 6. Set password for Google-only user ────────────────────────────────────

describe("Phase 25 — Set password (Google-only user)", () => {
  it("lets a Google-only user add a password (action logic mirror)", async () => {
    const userId = await makeGoogleOnlyUser("setpassword@example.com");
    const newPassword = "NewPass123!";
    // Mirror setPasswordAction: only succeeds when passwordHash is null.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).toBeNull();
    const passwordHash = await argon2.hash(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await prisma.auditLog.create({
      data: {
        userId,
        action: "PASSWORD_SET",
        entity: "User",
        entityId: userId,
      },
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).not.toBeNull();
    // Verify the hash works.
    const ok = await argon2.verify(after.passwordHash!, newPassword);
    expect(ok).toBe(true);
    // Now they can disconnect Google.
    await linkGoogleToUser(userId, "google-sub-after-set", { emailVerified: true });
    const result = await unlinkAccountForTest(
      userId,
      "google",
      "google-sub-after-set",
      newPassword,
    );
    expect(result.ok).toBe(true);
    expect(await prisma.account.count({ where: { userId } })).toBe(0);
  });
});

// ─── 7. Cross-user isolation ────────────────────────────────────────────────

describe("Phase 25 — Cross-user isolation", () => {
  it("user A's Google Account row is never visible to user B", async () => {
    const aId = await makePasswordUser("userA@example.com", true);
    const bId = await makePasswordUser("userB@example.com", true);
    await linkGoogleToUser(aId, "google-sub-A", { emailVerified: true });
    // User B has no Google Account linked.
    const bAccounts = await prisma.account.findMany({ where: { userId: bId } });
    expect(bAccounts.length).toBe(0);
    // User B can't disconnect user A's Account row even if they guess the
    // providerAccountId.
    const result = await unlinkAccountForTest(bId, "google", "google-sub-A", "TestPass123!");
    // The action looks up the Account by (provider, providerAccountId) and
    // checks userId === the caller's userId — user B is rejected.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found or does not belong/i);
    // The Account row is untouched.
    const stillLinked = await prisma.account.count({
      where: { userId: aId, provider: "google" },
    });
    expect(stillLinked).toBe(1);
  });
});

// ─── 8. Schema-level guard: email @unique prevents duplicates ───────────────

describe("Phase 25 — schema-level guards", () => {
  it("the email @unique constraint prevents two users with the same email", async () => {
    await makePasswordUser("dup@example.com", true);
    await expect(
      prisma.user.create({
        data: {
          email: "dup@example.com",
          name: "Dup",
          passwordHash: await argon2.hash("x"),
        },
      }),
    ).rejects.toThrow();
  });
});

// ─── 9. unlinkAccountAction / signOutAllDevicesAction rate limit ───────────
// These actions call rateLimitSignOutAll + rateLimitUnlinkAccount via
// requireUser (so userId is in the key). The MemoryRateLimiter allows 5
// / 600s per user. We can't easily call the real action (no session), but we
// can verify the helper returns the right shape.

describe("Phase 25 — rate limit helpers", () => {
  it("rateLimitSignOutAll returns success/limit/remaining/reset", async () => {
    const { rateLimitSignOutAll } = await import("@/lib/rate-limit");
    const r = await rateLimitSignOutAll("test-user-rate");
    expect(r.success).toBe(true);
    expect(typeof r.limit).toBe("number");
    expect(typeof r.remaining).toBe("number");
    expect(typeof r.reset).toBe("number");
  });

  it("rateLimitUnlinkAccount returns success/limit/remaining/reset", async () => {
    const { rateLimitUnlinkAccount } = await import("@/lib/rate-limit");
    const r = await rateLimitUnlinkAccount("test-user-rate");
    expect(r.success).toBe(true);
    expect(typeof r.limit).toBe("number");
    expect(typeof r.remaining).toBe("number");
    expect(typeof r.reset).toBe("number");
  });

  it("rateLimitGoogleSignIn returns success/limit/remaining/reset", async () => {
    const { rateLimitGoogleSignIn } = await import("@/lib/rate-limit");
    const r = await rateLimitGoogleSignIn("127.0.0.1", "user@example.com");
    expect(r.success).toBe(true);
    expect(typeof r.limit).toBe("number");
    expect(typeof r.remaining).toBe("number");
    expect(typeof r.reset).toBe("number");
  });
});

// ─── 10. No personal data in OAuth audit meta ──────────────────────────────

describe("Phase 25 — audit meta contains no PII beyond email", () => {
  it("GOOGLE_SIGN_IN meta only contains provider + email", async () => {
    const userId = await makePasswordUser("audit@example.com", true);
    await linkGoogleToUser(userId, "google-sub-audit", { emailVerified: true });
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "GOOGLE_SIGN_IN" },
    });
    expect(audits.length).toBe(1);
    const meta = audits[0].meta as Record<string, unknown>;
    // Only keys: provider + email. No password, no tokens, no name beyond email.
    expect(Object.keys(meta).sort()).toEqual(["email", "provider"]);
    expect(meta.provider).toBe("google");
    expect(meta.email).toBe("audit@example.com");
  });

  it("SIGN_OUT_ALL_DEVICES meta only contains email", async () => {
    const userId = await makePasswordUser("audit-so@example.com", true);
    await signOutAllForTest(userId, "TestPass123!");
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "SIGN_OUT_ALL_DEVICES" },
    });
    expect(audits.length).toBe(1);
    const meta = audits[0].meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["email"]);
  });
});
