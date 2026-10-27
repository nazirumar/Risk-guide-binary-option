"use server";

/**
 * Auth server actions — register, verify-email, request reset, reset password.
 *
 * PROJECT_RULES.md rule #4: every input is validated with Zod on the server,
 * even though the client validates too. Rule #3: every query is scoped by
 * userId — but auth actions don't have a userId yet, so they accept the
 * identifier (email / token) directly.
 *
 * Generic error messages — no account enumeration. Forgot-password always
 * returns success even if the email doesn't exist.
 */
import { randomUUID } from "node:crypto";
import argon2 from "argon2";

import { db } from "@/lib/db";
import {
  registerSchema,
  resetPasswordSchema,
  forgotPasswordSchema,
  verifyEmailSchema,
} from "@/lib/validation";
import {
  sendEmail,
  emailVerificationEmail,
  passwordResetEmail,
  googleAccountEmail,
} from "@/lib/email";
import {
  rateLimitRegister,
  rateLimitForgotPassword,
  rateLimitResetPassword,
  rateLimitVerifyEmail,
  getRequestIp,
} from "@/lib/rate-limit";
import { headers } from "next/headers";

const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export type ActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

// ─── Register ────────────────────────────────────────────────────────────────

export async function registerAction(formData: FormData): Promise<ActionResult> {
  const req = new Request("http://localhost/register", {
    headers: Object.fromEntries((await headers()).entries()),
  });
  const ip = getRequestIp(req);
  const rl = await rateLimitRegister(ip);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    acceptTerms: formData.get("acceptTerms") === "on" ? true : undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      message: "Please correct the highlighted fields.",
      fieldErrors,
    };
  }

  const { name, email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const existing = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existing) {
    // Generic — don't reveal whether the email is taken.
    return {
      ok: false,
      message: "Registration failed. Please try a different email.",
    };
  }

  const passwordHash = await argon2.hash(password);
  const user = await db.user.create({
    data: {
      name,
      email: normalizedEmail,
      passwordHash,
      isOnboarded: false,
    },
  });

  // Email verification token — 24h expiry.
  const token = randomUUID();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.verificationToken.create({
    data: { identifier: normalizedEmail, token, expires },
  });

  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  await sendEmail(emailVerificationEmail(normalizedEmail, verifyUrl));

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "REGISTER",
      entity: "User",
      entityId: user.id,
      meta: { email: normalizedEmail },
    },
  });

  return {
    ok: true,
    message:
      "Account created. Check your email for a verification link (in dev, check the server console).",
  };
}

// ─── Verify email ────────────────────────────────────────────────────────────

export async function verifyEmailAction(formData: FormData): Promise<ActionResult> {
  const req = new Request("http://localhost/verify-email", {
    headers: Object.fromEntries((await headers()).entries()),
  });
  const ip = getRequestIp(req);
  const rl = await rateLimitVerifyEmail(ip);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const parsed = verifyEmailSchema.safeParse({
    token: formData.get("token") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, message: "Invalid verification link." };
  }

  const token = parsed.data.token;
  const verification = await db.verificationToken.findUnique({
    where: { token },
  });

  if (!verification || verification.expires < new Date()) {
    if (verification) {
      // Expired — clean up.
      await db.verificationToken.delete({ where: { token } });
    }
    return {
      ok: false,
      message: "This verification link is invalid or expired. Request a new one.",
    };
  }

  // Mark the user as verified.
  const user = await db.user.findUnique({
    where: { email: verification.identifier },
    select: { id: true, emailVerified: true },
  });
  if (!user) {
    return { ok: false, message: "No account found for this verification link." };
  }
  if (!user.emailVerified) {
    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    });
  }
  await db.verificationToken.delete({ where: { token } });

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "EMAIL_VERIFIED",
      entity: "User",
      entityId: user.id,
    },
  });

  return {
    ok: true,
    message:
      "Email verified. You can now sign in. You'll be prompted to complete onboarding on first login.",
  };
}

// ─── Resend verification ──────────────────────────────────────────────────────

export async function resendVerificationAction(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").toLowerCase();
  if (!email) {
    return { ok: false, message: "Email is required." };
  }
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true },
  });
  // Generic message — never reveal whether the email exists.
  const genericMessage =
    "If the email exists and isn't verified, you'll receive a new verification link.";
  if (!user || user.emailVerified) {
    return { ok: true, message: genericMessage };
  }
  const token = randomUUID();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.verificationToken.create({
    data: { identifier: email, token, expires },
  });
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  await sendEmail(emailVerificationEmail(email, verifyUrl));
  return { ok: true, message: genericMessage };
}

// ─── Forgot password ──────────────────────────────────────────────────────────

export async function forgotPasswordAction(formData: FormData): Promise<ActionResult> {
  const req = new Request("http://localhost/forgot-password", {
    headers: Object.fromEntries((await headers()).entries()),
  });
  const ip = getRequestIp(req);
  const parsed = forgotPasswordSchema.safeParse({
    email: formData.get("email") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, message: "Enter a valid email." };
  }
  const rl = await rateLimitForgotPassword(ip, parsed.data.email);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const email = parsed.data.email.toLowerCase();
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Always return the same generic success message — no account enumeration.
  const genericMessage = "If the email exists, you'll receive a reset link within a few minutes.";

  if (!user) {
    return { ok: true, message: genericMessage };
  }

  // Phase 25: Google-only users (no passwordHash) get an alternate email
  // explaining they signed up with Google + a link to the Google sign-in
  // page. The PUBLIC form message stays identical — we never reveal whether
  // the account exists from the form response. The email itself is the only
  // place where we tell the user which sign-in method they used.
  if (!user.passwordHash) {
    // Audit the request (no PII beyond the user's own id).
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_RESET_REQUESTED",
        entity: "User",
        entityId: user.id,
        meta: { googleOnly: true } as never,
      },
    });
    // Send the Google-aware email.
    const signInUrl = `${APP_URL}/login`;
    await sendEmail(googleAccountEmail(email, signInUrl));
    return { ok: true, message: genericMessage };
  }

  const token = randomUUID();
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
  await db.passwordReset.create({
    data: { userId: user.id, token, expires },
  });

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  await sendEmail(passwordResetEmail(email, resetUrl));

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      entity: "User",
      entityId: user.id,
    },
  });

  return { ok: true, message: genericMessage };
}

// ─── Reset password ──────────────────────────────────────────────────────────

export async function resetPasswordAction(formData: FormData): Promise<ActionResult> {
  const req = new Request("http://localhost/reset-password", {
    headers: Object.fromEntries((await headers()).entries()),
  });
  const ip = getRequestIp(req);
  const rl = await rateLimitResetPassword(ip);
  if (!rl.success) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil((rl.reset - Date.now()) / 1000)}s.`,
    };
  }

  const parsed = resetPasswordSchema.safeParse({
    token: formData.get("token") ?? "",
    password: formData.get("password") ?? "",
    confirmPassword: formData.get("confirmPassword") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString();
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      message: "Please fix the highlighted fields.",
      fieldErrors,
    };
  }

  const { token, password } = parsed.data;
  const reset = await db.passwordReset.findUnique({
    where: { token },
  });
  if (!reset || reset.expires < new Date() || reset.usedAt) {
    if (reset && reset.expires < new Date()) {
      await db.passwordReset.delete({ where: { id: reset.id } });
    }
    return {
      ok: false,
      message: "This reset link is invalid or expired. Request a new one.",
    };
  }

  const passwordHash = await argon2.hash(password);
  await db.$transaction([
    db.user.update({
      where: { id: reset.userId },
      data: { passwordHash },
    }),
    db.passwordReset.update({
      where: { id: reset.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await db.auditLog.create({
    data: {
      userId: reset.userId,
      action: "PASSWORD_RESET_COMPLETED",
      entity: "User",
      entityId: reset.userId,
    },
  });

  return {
    ok: true,
    message: "Password updated. You can now sign in with your new password.",
  };
}
