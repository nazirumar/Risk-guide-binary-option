import { AlertCircle } from "lucide-react";
export default function PrivacyPage() {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-2xl space-y-4">
      <h1>Privacy Policy</h1>
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs flex items-start gap-2">
        <AlertCircle className="size-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>Important:</strong> This is a generic template. Have it reviewed by legal counsel
          before production use.
        </span>
      </div>
      <h2>1. Data We Collect</h2>
      <p>
        Email address, password hash (argon2), timezone, trading accounts, trades, transactions,
        discipline scores, and settings preferences.
      </p>
      <h2>2. Data We Do NOT Share</h2>
      <p>
        We never share your email, name, or individual trade details with third parties. The AI
        weekly review feature sends only aggregated statistics (never email, name, or screenshots)
        to Anthropic, and only when you explicitly opt in.
      </p>
      <h2>3. Payment Processing</h2>
      <p>
        Subscriptions are processed via Paystack or Stripe. We store your subscription status and
        payment records but do not store full card numbers — these are handled entirely by the
        payment provider.
      </p>
      <h2>4. Data Retention</h2>
      <p>
        Your data is retained for as long as your account is active. Downgrading your plan does not
        delete your data. Account deletion permanently removes all data.
      </p>
      <h2>5. Your Rights</h2>
      <p>
        You may export your data at any time via the Reports page. You may delete your account and
        all associated data via Settings.
      </p>
    </div>
  );
}
