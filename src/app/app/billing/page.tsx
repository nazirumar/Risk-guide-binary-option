import Link from "next/link";
import { CreditCard, Crown, Check, AlertCircle } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { ensureSubscriptionAction, getBillingOverviewAction } from "@/server/actions/billing";
import { PLAN_CONFIGS } from "@/lib/billing/plans";
import { formatMoney, formatDate } from "@/lib/format";
import { BillingActionsClient } from "@/components/billing/BillingActionsClient";

export default async function BillingPage() {
  const { userId } = await requireUser();
  await ensureSubscriptionAction();
  const result = await getBillingOverviewAction();
  const overview = result.overview;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing & Plans</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription</p>
      </div>

      {overview && (
        <>
          {/* Current plan */}
          <div className="rounded-lg border border-border p-4" data-testid="current-plan-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  {overview.plan === "PRO" && (
                    <Crown className="size-5 text-warning" aria-hidden="true" />
                  )}
                  <h2 className="text-lg font-bold">{PLAN_CONFIGS[overview.plan].label}</h2>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      overview.status === "ACTIVE"
                        ? "bg-profit/15 text-profit"
                        : overview.status === "PAST_DUE"
                          ? "bg-loss/15 text-loss"
                          : overview.status === "CANCELLED"
                            ? "bg-warning/15 text-warning"
                            : "bg-muted text-muted-foreground"
                    }`}
                    data-testid="plan-status"
                  >
                    {overview.status}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {PLAN_CONFIGS[overview.plan].description}
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums">
                  {overview.monthlyPrice === 0
                    ? "Free"
                    : formatMoney(overview.monthlyPrice, overview.currency)}
                </div>
                <div className="text-xs text-muted-foreground">/ month</div>
              </div>
            </div>
            {overview.cancelAtPeriodEnd && overview.currentPeriodEnd && (
              <div
                className="mt-3 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning"
                data-testid="cancel-notice"
              >
                <AlertCircle className="size-3.5 inline mr-1" aria-hidden="true" />
                Access continues until {formatDate(overview.currentPeriodEnd)} — then downgrades to
                Free.
              </div>
            )}
            {overview.gracePeriodEndsAt && (
              <div
                className="mt-3 rounded-md border border-loss/30 bg-loss/5 p-2 text-xs text-loss"
                data-testid="grace-notice"
              >
                <AlertCircle className="size-3.5 inline mr-1" aria-hidden="true" />
                Payment failed — grace period ends {formatDate(overview.gracePeriodEndsAt)}. Update
                your payment method.
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <BillingActionsClient
                plan={overview.plan}
                status={overview.status}
                cancelAtPeriodEnd={overview.cancelAtPeriodEnd}
              />
            </div>
          </div>

          {/* Plan comparison */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(Object.keys(PLAN_CONFIGS) as ("FREE" | "PRO")[]).map((key) => {
              const config = PLAN_CONFIGS[key];
              const isCurrent = overview.plan === key;
              return (
                <div
                  key={key}
                  className={`rounded-lg border p-4 ${isCurrent ? "border-primary" : "border-border"}`}
                  data-testid={`plan-card-${key}`}
                >
                  <h3 className="font-bold flex items-center gap-2">
                    {key === "PRO" && <Crown className="size-4 text-warning" aria-hidden="true" />}
                    {config.label}
                    {isCurrent && (
                      <span className="text-xs text-muted-foreground font-normal">(current)</span>
                    )}
                  </h3>
                  <div className="text-2xl font-bold mt-1">
                    {config.monthlyPriceNGN === 0
                      ? "Free"
                      : `${formatMoney(config.monthlyPriceNGN, "NGN")}/mo`}
                  </div>
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <li>
                      {config.maxAccounts == null
                        ? "Unlimited accounts"
                        : `${config.maxAccounts} account${config.maxAccounts === 1 ? "" : "s"}`}
                    </li>
                    <li>
                      {config.maxTradesPerMonth == null
                        ? "Unlimited trades"
                        : `${config.maxTradesPerMonth} trades/month`}
                    </li>
                    {config.features.map((f) => (
                      <li key={f} className="flex items-center gap-1">
                        <Check className="size-3 text-profit" aria-hidden="true" />
                        {f.replace(/-/g, " ")}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          {/* Payment history */}
          {overview.payments.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold flex items-center gap-1.5">
                  <CreditCard className="size-4" aria-hidden="true" />
                  Payment history
                </h2>
              </div>
              <table className="w-full text-sm" data-testid="payment-history-table">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5 text-right">Amount</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Invoice</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {overview.payments.map((p) => (
                    <tr key={p.id} data-testid="payment-history-row">
                      <td className="px-4 py-3">{formatDate(p.createdAt)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMoney(Number(p.amount), p.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={p.status === "SUCCESS" ? "text-profit" : "text-loss"}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline text-xs"
                          >
                            view
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Legal links */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <Link href="/app/legal/terms" className="hover:text-foreground">
              Terms of Service
            </Link>
            <Link href="/app/legal/privacy" className="hover:text-foreground">
              Privacy Policy
            </Link>
            <Link href="/app/legal/refund" className="hover:text-foreground">
              Refund Policy
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
