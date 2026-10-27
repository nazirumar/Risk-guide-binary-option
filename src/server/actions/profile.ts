"use server";

/**
 * Profile server actions — update name/timezone/currency, change password,
 * set password (Phase 25 — Google-only users), delete account (with cascade).
 *
 * PROJECT_RULES.md rule #3: userId always from the session.
 */
import { revalidatePath } from "next/cache";
import argon2 from "argon2";

import { db } from "@/lib/db";
import {
  updateProfileSchema,
  changePasswordSchema,
  setPasswordSchema,
  deleteAccountSchema,
} from "@/lib/validation";
import { requireUser } from "@/server/lib/require-user";

export type ProfileResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

// ─── Update profile ──────────────────────────────────────────────────────────

export async function updateProfileAction(formData: FormData): Promise<ProfileResult> {
  const { userId } = await requireUser();
  const parsed = updateProfileSchema.safeParse({
    name: formData.get("name") ?? "",
    timezone: formData.get("timezone") ?? "",
    baseCurrency: String(formData.get("baseCurrency") ?? "").toUpperCase(),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Fix the highlighted fields.", fieldErrors };
  }

  await db.user.update({
    where: { id: userId },
    data: {
      name: parsed.data.name,
      timezone: parsed.data.timezone,
      baseCurrency: parsed.data.baseCurrency,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "PROFILE_UPDATED",
      entity: "User",
      entityId: userId,
    },
  });
  revalidatePath("/app/settings");
  return { ok: true, message: "Profile updated." };
}

// ─── Change password ─────────────────────────────────────────────────────────
// Phase 25: bumps sessionVersion so all OTHER sessions on other devices are
// invalidated on the next sessionVersion check (≤60s). The CURRENT session
// is unaffected — the client-side useSession().update() refreshes the token
// with the new sessionVersion after this action succeeds.

export async function changePasswordAction(formData: FormData): Promise<ProfileResult> {
  const { userId } = await requireUser();
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword") ?? "",
    newPassword: formData.get("newPassword") ?? "",
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

  const { currentPassword, newPassword } = parsed.data;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user || !user.passwordHash) {
    return { ok: false, message: "Account has no password set. Use 'Set a password' instead." };
  }

  const ok = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
  if (!ok) {
    return {
      ok: false,
      message: "Current password is incorrect.",
      fieldErrors: { currentPassword: "Incorrect password." },
    };
  }

  const passwordHash = await argon2.hash(newPassword);
  // Bump sessionVersion atomically so other-device tokens are invalidated.
  await db.user.update({
    where: { id: userId },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "PASSWORD_CHANGED",
      entity: "User",
      entityId: userId,
    },
  });

  return { ok: true, message: "Password changed. Other devices will be signed out shortly." };
}

// ─── Set password (Phase 25 — Google-only users) ────────────────────────────
// A Google-only user (passwordHash = null) can set a password to enable email/
// password login alongside Google. No currentPassword required (they don't
// have one). After setting, they can disconnect their Google Account if they
// want to (otherwise disconnect is blocked because Google is the only sign-in
// method).

export async function setPasswordAction(formData: FormData): Promise<ProfileResult> {
  const { userId } = await requireUser();
  const parsed = setPasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword") ?? "",
    newPassword: formData.get("newPassword") ?? "",
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

  const { newPassword } = parsed.data;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true },
  });
  if (!user) {
    return { ok: false, message: "Account not found." };
  }
  if (user.passwordHash) {
    // Already has a password — point them to "Change password" instead.
    return {
      ok: false,
      message: "This account already has a password. Use 'Change password' instead.",
    };
  }

  const passwordHash = await argon2.hash(newPassword);
  await db.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
  await db.auditLog.create({
    data: {
      userId,
      action: "PASSWORD_SET",
      entity: "User",
      entityId: userId,
      meta: { email: user.email } as never,
    },
  });

  return { ok: true, message: "Password set. You can now sign in with email and password." };
}

// ─── Delete account (with cascade) ──────────────────────────────────────────

export async function deleteAccountAction(formData: FormData): Promise<ProfileResult> {
  const { userId } = await requireUser();
  const parsed = deleteAccountSchema.safeParse({
    confirmPhrase: formData.get("confirmPhrase") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Type "DELETE MY ACCOUNT" exactly to confirm.',
      fieldErrors: { confirmPhrase: "Confirmation phrase doesn't match." },
    };
  }

  // All child relations have onDelete: Cascade, so this single delete will
  // cascade through every domain table. Audit log entry is captured BEFORE
  // the delete because audit logs also cascade.
  await db.auditLog.create({
    data: {
      userId,
      action: "ACCOUNT_DELETED",
      entity: "User",
      entityId: userId,
    },
  });
  await db.user.delete({ where: { id: userId } });

  // No revalidatePath — the user is now unauthenticated; the middleware will
  // bounce them to /login on the next request.
  return { ok: true, message: "Account deleted. Sorry to see you go." };
}
