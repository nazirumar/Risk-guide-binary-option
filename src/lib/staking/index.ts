/**
 * Public API for the Phase 8 staking module. Re-exports the plan functions,
 * Monte Carlo simulator, next-stake suggestion, and types so callers
 * import from one place: `@/lib/staking`.
 */

// Types
export type {
  StakingContext,
  PlanConfig,
  StakingPlanFn,
  SimulationResult,
  MonteCarloResult,
  TradeOutcome,
} from "./types";

// Plan functions + registry
export {
  computeNextStake,
  isMartingale,
  martingaleWorstCaseExposure,
  martingaleCapHitProbability,
  kellyFullFraction,
  DEFAULT_CONFIGS,
} from "./plans";

// Monte Carlo
export { simulateOnce, runMonteCarlo } from "./monte-carlo";

// Next-stake suggestion (server-side — uses db)
export { getNextStakeSuggestion, parsePlanConfig } from "./next-stake";
export type { NextStakeSuggestion } from "./next-stake";
