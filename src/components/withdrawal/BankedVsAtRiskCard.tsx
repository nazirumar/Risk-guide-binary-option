/**
 * Phase 19 — Banked-vs-at-risk dashboard card.
 *
 * Server Component. Pulls the active account's totals via the
 * `getBankedVsAtRiskAction` server action and renders the two numbers side
 * by side. "Banked" is green (positive = profit moved out of the broker);
 * "At risk" is amber (capital still in the account). The card surfaces the
 * core Phase 19 discipline metric: how much money have you actually secured
 * vs how much is still on the line.
 */
import Link from "next/link";
import { PiggyBank, AlertTriangle } from "lucide-react";
import { getBankedVsAtRiskAction } from "@/server/actions/withdrawals";
import { formatMoney } from "@/lib/format";
import Decimal from "decimal.js";

export async function BankedVsAtRiskCard() {
  const res = await getBankedVsAtRiskAction();
  if (!res.ok || res.banked == null || res.atRisk == null) return null;

  const banked = new Decimal(res.banked);
  const atRisk = new Decimal(res.atRisk);
  const currency = res.currency ?? "USD";

  return (
    <Link
      href="/app/withdrawal"
      className="block rounded-lg border border-border p-4 hover:bg-accent/30 transition-colors"
      data-testid="banked-vs-at-risk"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Banked profit vs at risk
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            <PiggyBank className="size-3" aria-hidden="true" />
            Banked
          </div>
          <div
            className={`text-xl font-bold tabular-nums ${banked.gte(0) ? "text-profit" : "text-loss"}`}
            data-testid="banked-amount"
          >
            {banked.gte(0) ? "+" : "−"}
            {formatMoney(banked.abs(), currency)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">withdrawn − deposited</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            <AlertTriangle className="size-3" aria-hidden="true" />
            At risk
          </div>
          <div className="text-xl font-bold tabular-nums text-warning" data-testid="at-risk-amount">
            {formatMoney(atRisk, currency)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">still in the broker</div>
        </div>
      </div>
      {banked.lt(0) && (
        <p className="text-[10px] text-muted-foreground mt-2">
          Net-down on principal: still recovering what you deposited.
        </p>
      )}
    </Link>
  );
}
