"use server";

/**
 * Phase 25 — Google OAuth account management actions.
 *
 *   - signOutAllDevicesAction: bumps User.sessionVersion so all outstanding
 *     JWTs are stripped on their next sessionVersion check (≤60s).
 *   - unlinkAccountAction: removes the Account row for a connected Google
     account, but ONLY if the user has a passwordHash (so they can still sign
     in). Otherwise the action is blocked — tell them to set a password first.
 *
 * PROJECT_RULES.md rule #3: every query is scoped by userId from the session.
 * Rule #8: state changes write AuditLog entries.
 */
import argon2 from "argon2";

import { db } from "@/lib/db";
import { unlinkAccountSchema, signOutAllSchema } from "@/lib/validation";
import { requireUser } from "@/server/lib/require-user";
import { rateLimitSignOutAll, rateLimitUnlinkAccount } from "@/lib/rate-limit";

export type OAuthActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

// ─── Sign out of all devices ────────────────────────────────────────────────

export async function signOutAllDevicesAction(formData: FormData): Promise<OAuthActionResult> {
  const { userId } = await requireUser();

  const rl = await rateLimitSignOutAll(userId);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const parsed = signOutAllSchema.safeParse({
    confirmPassword: formData.get("confirmPassword") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: "Re-authentication failed.",
      fieldErrors: { confirmPassword: "Confirm your password." },
    };
  }

  // Re-auth requirement (spec point 7): verify the user's current password
  // before mass-invalidating sessions. Google-only users (no passwordHash)
  // can re-auth via a fresh Google sign-in — but we can't verify a fresh
  // Google token here without a separate flow. For now, we require password
  // re-auth. Google-only users must set a password first (Phase 25 point 5).
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true },
  });
  if (!user) {
    return { ok: false, message: "Account not found." };
  }
  if (!user.passwordHash) {
    return {
      ok: false,
      message: "Set a password first to re-authenticate, then sign out of all devices.",
      fieldErrors: { confirmPassword: "Google-only accounts must set a password first." },
    };
  }
  const confirmPassword = parsed.data.confirmPassword ?? "";
  const ok = await argon2.verify(user.passwordHash, confirmPassword).catch(() => false);
  if (!ok) {
    return {
      ok: false,
      message: "Password is incorrect.",
      fieldErrors: { confirmPassword: "Incorrect password." },
    };
  }

  // Bump sessionVersion — the jwt callback will strip outstanding tokens on
  // the next sessionVersion check. The CURRENT session is also invalidated
  // (the client will call signOut() after this action succeeds).
  await db.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "SIGN_OUT_ALL_DEVICES",
      entity: "User",
      entityId: userId,
      meta: { email: user.email } as never,
    },
  });

  return {
    ok: true,
    message: "All other devices have been signed out. You will be signed out of this device too.",
  };
}

// ─── Disconnect a Google account ─────────────────────────────────────────────

export async function unlinkAccountAction(formData: FormData): Promise<OAuthActionResult> {
  const { userId } = await requireUser();

  const rl = await rateLimitUnlinkAccount(userId);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const parsed = unlinkAccountSchema.safeParse({
    provider: formData.get("provider") ?? "",
    providerAccountId: formData.get("providerAccountId") ?? "",
    confirmPassword: formData.get("confirmPassword") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Fix the highlighted fields.", fieldErrors };
  }

  const { provider, providerAccountId, confirmPassword } = parsed.data;

  // Look up the user — we need both their passwordHash AND the Account row.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true },
  });
  if (!user) {
    return { ok: false, message: "Account not found." };
  }

  // Spec point 6: block disconnect if Google is the only sign-in method.
  if (!user.passwordHash) {
    return {
      ok: false,
      message: "Google is your only sign-in method. Set a password before disconnecting Google.",
      fieldErrors: {
        confirmPassword:
          "Set a password in Profile first, then come back here to disconnect Google.",
      },
    };
  }

  // Re-auth requirement (spec point 7).
  const ok = await argon2.verify(user.passwordHash, confirmPassword).catch(() => false);
  if (!ok) {
    return {
      ok: false,
      message: "Password is incorrect.",
      fieldErrors: { confirmPassword: "Incorrect password." },
    };
  }

  // Verify the Account row exists and belongs to this user (defense in depth:
  // even though requireUser scoped us, the unlinkAccountSchema doesn't know
  // which user — so we check before deleting).
  const account = await db.account.findUnique({
    where: {
      provider_providerAccountId: { provider, providerAccountId },
    },
    select: { userId: true },
  });
  if (!account || account.userId !== userId) {
    return { ok: false, message: "Account not found or does not belong to you." };
  }

  await db.account.delete({
    where: { provider_providerAccountId: { provider, providerAccountId } },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "ACCOUNT_UNLINKED",
      entity: "Account",
      entityId: providerAccountId,
      meta: { provider, email: user.email } as never,
    },
  });

  return {
    ok: true,
    message: "Google account disconnected. You can still sign in with your password.",
  };
}
