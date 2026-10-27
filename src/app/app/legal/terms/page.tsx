import { AlertCircle } from "lucide-react";
export default function TermsPage() {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-2xl space-y-4">
      <h1>Terms of Service</h1>
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs flex items-start gap-2">
        <AlertCircle className="size-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>Important:</strong> This is a generic template provided for convenience. It has
          not been reviewed by a lawyer. You must have it reviewed by qualified legal counsel before
          using it in production. RiskGuard is not responsible for the legal adequacy of this
          document.
        </span>
      </div>
      <h2>1. Acceptance of Terms</h2>
      <p>
        By creating an account and using RiskGuard, you agree to these Terms of Service. If you do
        not agree, you may not use the service.
      </p>
      <h2>2. Service Description</h2>
      <p>
        RiskGuard is a money-management and risk-management tool for binary options traders. It
        provides trade journaling, analytics, discipline tracking, and educational features. It is{" "}
        <strong>not</strong> a financial advisor, broker, or trading platform.
      </p>
      <h2>3. Risk Disclaimer</h2>
      <p>
        Binary options are high-risk financial instruments. Most traders lose money. RiskGuard is a
        discipline tool — it does not predict market direction, recommend trades, or guarantee
        profits. Past performance does not guarantee future results. You are solely responsible for
        your trading decisions.
      </p>
      <h2>4. Plans and Billing</h2>
      <p>
        The Free plan is available at no cost with limited features. The Pro plan requires a
        recurring subscription fee. You may cancel at any time; access continues until the end of
        the current billing period. Downgrades do not delete your data — you retain read access.
      </p>
      <h2>5. Data and Privacy</h2>
      <p>
        We store your trade data, account balances, and discipline scores on our servers. We do not
        share your personal data with third parties except as required for payment processing
        (Paystack/Stripe). See our <a href="/app/legal/privacy">Privacy Policy</a> for details.
      </p>
      <h2>6. Limitation of Liability</h2>
      <p>
        RiskGuard is provided "as is" without warranties of any kind. We are not liable for any
        trading losses, data loss, or service interruptions.
      </p>
      <h2>7. Changes to Terms</h2>
      <p>
        We may update these terms at any time. Continued use after changes constitutes acceptance.
      </p>
    </div>
  );
}
