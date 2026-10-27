import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { db } from "@/lib/db";
import { StakeCalculatorClient } from "@/components/staking/StakeCalculatorClient";
import Decimal from "decimal.js";

export default async function StakeCalculatorPage() {
  const { userId } = await requireUser();
  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();

  // Fetch user's saved staking plans.
  const plans = await db.stakingPlan.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      method: true,
      config: true,
      isDefault: true,
    },
  });

  // Serialize plan configs (Prisma JSON is already plain, but stringify Decimal-less).
  const serializedPlans = plans.map((p) => ({
    id: p.id,
    name: p.name,
    method: p.method,
    config: p.config as Record<string, unknown>,
    isDefault: p.isDefault,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Stake Calculator</h1>
        <p className="text-sm text-muted-foreground">
          Size your stakes, compare staking plans, simulate 1,000 runs.
        </p>
      </div>
      <StakeCalculatorClient
        initialBalance={activeAccount ? Number(activeAccount.currentBalance) : 1000}
        currency={activeAccount?.currency ?? "USD"}
        accountName={activeAccount?.name ?? null}
        plans={serializedPlans}
      />
    </div>
  );
}
