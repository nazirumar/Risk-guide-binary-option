import { AlertCircle } from "lucide-react";
export default function RefundPage() {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-2xl space-y-4">
      <h1>Refund Policy</h1>
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs flex items-start gap-2">
        <AlertCircle className="size-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>Important:</strong> This is a generic template. Have it reviewed by legal counsel
          before production use.
        </span>
      </div>
      <h2>1. Free Plan</h2>
      <p>The Free plan costs nothing — no refunds are applicable.</p>
      <h2>2. Pro Plan</h2>
      <p>
        Pro subscriptions are billed monthly in advance. If you cancel, you retain access until the
        end of the current billing period. No partial refunds are issued for unused time within the
        billing period.
      </p>
      <h2>3. Failed Payments</h2>
      <p>
        If a payment fails, your account enters a 3-day grace period. During this time, you retain
        full Pro access. After the grace period, your account downgrades to Free — your data is
        preserved and you retain read access.
      </p>
      <h2>4. Discretionary Refunds</h2>
      <p>
        Refund requests for specific circumstances (e.g. duplicate charges, provider errors) may be
        submitted to support. Each request is reviewed individually.
      </p>
    </div>
  );
}
