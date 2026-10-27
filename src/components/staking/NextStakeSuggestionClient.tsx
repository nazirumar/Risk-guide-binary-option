"use client";

/**
 * NextStakeSuggestion — client component that renders the next-stake
 * suggestion as a clickable link. When clicked, calls onApply(suggestedStake)
 * so the parent (AddTradeForm) can fill the stake field.
 *
 * The suggestion itself is fetched server-side (via
 * `getNextStakeSuggestion` in the parent trades page) and passed as a prop
 * because it needs DB access (StakingPlan + recent trades + RiskProfile).
 */
export function NextStakeSuggestionClient({
  suggestion,
  onApply,
}: {
  suggestion: {
    suggestedStake: string;
    planName: string;
    clamped: boolean;
  } | null;
  onApply: (stake: string) => void;
}) {
  if (!suggestion) return null;
  return (
    <div className="text-xs text-muted-foreground">
      Suggested:{" "}
      <button
        type="button"
        onClick={() => onApply(suggestion.suggestedStake)}
        className="font-medium text-primary hover:underline"
      >
        {suggestion.suggestedStake} ({suggestion.planName})
      </button>
      {suggestion.clamped && <span className="text-warning"> · clamped to Risk Rules limit</span>}
    </div>
  );
}
