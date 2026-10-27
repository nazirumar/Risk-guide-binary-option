import { getNextStakeSuggestion } from "@/lib/staking";
import { requireUser } from "@/server/lib/require-user";

/**
 * NextStakeSuggestion — server component that fetches the next-stake
 * suggestion for the active account + renders it as a small hint below the
 * stake input in the Add Trade form.
 *
 * Returns null if no suggestion (user has no default plan, or no recent
 * trades to compute from).
 */
export async function NextStakeSuggestion({ tradingAccountId }: { tradingAccountId: string }) {
  const { userId } = await requireUser();
  const suggestion = await getNextStakeSuggestion(userId, tradingAccountId);
  if (!suggestion) return null;

  return (
    <div className="text-xs text-muted-foreground">
      Suggested:{" "}
      <button
        type="button"
        data-suggested-stake={suggestion.suggestedStake}
        className="font-medium text-primary hover:underline"
        id="next-stake-suggestion"
      >
        {suggestion.suggestedStake} {suggestion.planName}
      </button>
      {suggestion.clamped && <span className="text-warning"> (clamped to Risk Rules limit)</span>}
    </div>
  );
}
