/**
 * Email service abstraction (PROJECT_RULES.md: Resend abstracted behind
 * /src/lib/email.ts so it can be swapped for any other provider — SES, Postmark,
 * SMTP, etc. — without touching call sites).
 *
 * Dev fallback: if RESEND_API_KEY is not set, the email payload is logged to
 * the console so tokens/links are still visible during local development.
 */
import { Resend } from "resend";

type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

interface EmailProvider {
  send(payload: EmailPayload): Promise<{ messageId?: string; previewUrl?: string }>;
}

class ConsoleEmailProvider implements EmailProvider {
  async send(payload: EmailPayload) {
    // Dev-only — surface the email so tokens/links are clickable during
    // local development without needing a real Resend key.
    const previewUrl = payload.html.match(/https?:\/\/[^\s<]+/g)?.[0];
    console.log("\n────────── EMAIL (dev console fallback) ──────────");
    console.log(`To:      ${payload.to}`);
    console.log(`Subject: ${payload.subject}`);
    console.log(`Body:    ${payload.text ?? "(HTML only)"}`);
    if (previewUrl) console.log(`Link:    ${previewUrl}`);
    console.log("──────────────────────────────────────────────────\n");
    return { previewUrl };
  }
}

class ResendEmailProvider implements EmailProvider {
  private client: Resend;
  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }
  async send(payload: EmailPayload) {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });
    if (error) {
      throw new Error(`Resend email failed: ${error.message}`);
    }
    return { messageId: data?.id };
  }
}

let _provider: EmailProvider | null = null;

function getProvider(): EmailProvider {
  if (_provider) return _provider;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "RiskGuard <onboarding@resend.dev>";
  if (apiKey && apiKey.length > 0) {
    _provider = new ResendEmailProvider(apiKey, from);
  } else {
    _provider = new ConsoleEmailProvider();
  }
  return _provider;
}

export async function sendEmail(payload: EmailPayload) {
  return getProvider().send(payload);
}

// ─── Pre-built templates (Phase 2 only; richer templates in Phase 12) ────────

export function emailVerificationEmail(to: string, verifyUrl: string): EmailPayload {
  return {
    to,
    subject: "Verify your RiskGuard email",
    html: `
      <div style="font-family:system-ui,Segoe,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
        <h1 style="margin:0 0 16px;font-size:22px">Verify your email</h1>
        <p style="margin:0 0 16px;color:#374151">
          Welcome to RiskGuard. Click the button below to confirm
          <strong>${to}</strong> and unlock your account.
        </p>
        <p style="margin:24px 0;text-align:center">
          <a href="${verifyUrl}"
             style="display:inline-block;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Verify my email
          </a>
        </p>
        <p style="margin:0;color:#6b7280;font-size:13px">
          Or paste this link: ${verifyUrl}<br/>
          This link expires in 24 hours. If you didn't sign up, ignore this email.
        </p>
      </div>
    `,
    text: `Welcome to RiskGuard.\n\nVerify your email by opening this link (expires in 24h):\n${verifyUrl}\n\nIf you didn't sign up, ignore this email.`,
  };
}

export function passwordResetEmail(to: string, resetUrl: string): EmailPayload {
  return {
    to,
    subject: "Reset your RiskGuard password",
    html: `
      <div style="font-family:system-ui,Segoe,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
        <h1 style="margin:0 0 16px;font-size:22px">Reset your password</h1>
        <p style="margin:0 0 16px;color:#374151">
          We received a password reset request for your RiskGuard account
          (<strong>${to}</strong>).
        </p>
        <p style="margin:24px 0;text-align:center">
          <a href="${resetUrl}"
             style="display:inline-block;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Reset my password
          </a>
        </p>
        <p style="margin:0;color:#6b7280;font-size:13px">
          Or paste this link: ${resetUrl}<br/>
          This link expires in 1 hour. If you didn't request a reset, ignore this email
          and your password will stay unchanged.
        </p>
      </div>
    `,
    text: `We received a password reset request for ${to}.\n\nReset your password by opening this link (expires in 1h):\n${resetUrl}\n\nIf you didn't request a reset, ignore this email.`,
  };
}

// ─── Phase 25: Google-only account forgot-password email ───────────────────
// When the email matches a Google-only account (passwordHash = null), we
// send this alternate email explaining they signed up with Google + a link
// back to the Google sign-in page. We still don't reveal on the public form
// whether the account exists — the form response stays generic. The email
// itself goes only to the address that owns the account.
export function googleAccountEmail(to: string, signInWithGoogleUrl: string): EmailPayload {
  return {
    to,
    subject: "Your RiskGuard account uses Google sign-in",
    html: `
      <div style="font-family:system-ui,Segoe,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
        <h1 style="margin:0 0 16px;font-size:22px">Your account uses Google sign-in</h1>
        <p style="margin:0 0 16px;color:#374151">
          We received a password request for your RiskGuard account
          (<strong>${to}</strong>), but this account was created with
          <strong>Google sign-in</strong> — there's no password to reset.
        </p>
        <p style="margin:0 0 16px;color:#374151">
          To sign in, use the "Continue with Google" button on the login page.
        </p>
        <p style="margin:24px 0;text-align:center">
          <a href="${signInWithGoogleUrl}"
             style="display:inline-block;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Go to sign in
          </a>
        </p>
        <p style="margin:0;color:#6b7280;font-size:13px">
          If you'd like to also set a password for this account, sign in with
          Google first, then visit Profile &rarr; Set a password.<br/>
          If you didn't request this email, you can safely ignore it.
        </p>
      </div>
    `,
    text: `We received a password request for ${to}, but this account was created with Google sign-in — there's no password to reset.\n\nSign in with Google: ${signInWithGoogleUrl}\n\nIf you'd like to also set a password, sign in with Google first, then visit Profile → Set a password.`,
  };
}
