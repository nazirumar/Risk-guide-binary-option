"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/trader/FormField";
import { StatCard } from "@/components/trader/StatCard";
import { MoneyText } from "@/components/trader/MoneyText";
import { PercentBadge } from "@/components/trader/PercentBadge";
import { MonteCarloChart } from "./MonteCarloChart";
import {
  runMonteCarlo,
  kellyFullFraction,
  martingaleWorstCaseExposure,
  martingaleCapHitProbability,
  isMartingale,
  type PlanConfig,
  type MonteCarloResult,
} from "@/lib/staking";
import { formatMoney, formatPercent } from "@/lib/format";
import {
  createStakingPlanAction,
  deleteStakingPlanAction,
  setDefaultStakingPlanAction,
} from "@/server/actions/staking-plans";
import { toast } from "@/hooks/use-toast";
import { Trash2, Star, AlertTriangle, Plus, Calculator } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

type SerializedPlan = {
  id: string;
  name: string;
  method: string;
  config: Record<string, unknown>;
  isDefault: boolean;
};

const METHODS = [
  "FIXED_AMOUNT",
  "FIXED_PERCENT",
  "COMPOUNDING",
  "ANTI_MARTINGALE",
  "FIBONACCI",
  "MARTINGALE",
  "KELLY_FRACTION",
  "CUSTOM",
] as const;

const DEFAULT_CONFIGS: Record<string, PlanConfig> = {
  FIXED_AMOUNT: { method: "FIXED_AMOUNT", amount: 10 },
  FIXED_PERCENT: { method: "FIXED_PERCENT", percent: 0.02 },
  COMPOUNDING: { method: "COMPOUNDING", percent: 0.02 },
  ANTI_MARTINGALE: {
    method: "ANTI_MARTINGALE",
    basePercent: 0.02,
    increaseFactor: 1.5,
    capPercent: 0.06,
  },
  FIBONACCI: { method: "FIBONACCI", baseUnit: 1, maxSteps: 8 },
  MARTINGALE: { method: "MARTINGALE", baseUnit: 1, maxSteps: 5 },
  KELLY_FRACTION: { method: "KELLY_FRACTION", fraction: 0.5 },
  CUSTOM: { method: "CUSTOM", ladder: [10, 20, 30, 40] },
};

export function StakeCalculatorClient({
  initialBalance,
  currency,
  accountName,
  plans,
}: {
  initialBalance: number;
  currency: string;
  accountName: string | null;
  plans: SerializedPlan[];
}) {
  const [balance, setBalance] = useState(String(initialBalance));
  const [riskPercent, setRiskPercent] = useState("2");
  const [payoutPercent, setPayoutPercent] = useState("0.85");
  const [winRate, setWinRate] = useState("0.55");
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(
    plans.find((p) => p.isDefault)?.id ?? plans[0]?.id ?? null,
  );
  const [simResult, setSimResult] = useState<MonteCarloResult | null>(null);
  const [simPending, setSimPending] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Compute outputs from inputs (recommended stake, P/L, break-even, losses-to-ruin, Kelly variants).
  const outputs = useMemo(() => {
    const bal = Number(balance) || 0;
    const risk = Number(riskPercent) || 0;
    const payout = Number(payoutPercent) || 0;
    const wr = Number(winRate) || 0;

    if (bal <= 0 || risk <= 0 || payout <= 0) return null;

    const recommendedStake = bal * (risk / 100);
    const potentialProfit = recommendedStake * payout;
    const potentialLoss = recommendedStake;
    const breakEven = 1 / (1 + payout);
    const lossesToRuin = Math.ceil((bal * 0.5) / recommendedStake); // ruin at 50%

    const kellyFull = kellyFullFraction(wr, payout);
    const kellyStakeFull = bal * kellyFull;
    const kellyStakeHalf = bal * kellyFull * 0.5;
    const kellyStakeQuarter = bal * kellyFull * 0.25;

    // Expectancy per trade.
    const edge = wr * (1 + payout) - 1;
    const expectancy = recommendedStake * edge;

    return {
      recommendedStake,
      potentialProfit,
      potentialLoss,
      breakEven,
      lossesToRuin,
      kellyFull,
      kellyStakeFull,
      kellyStakeHalf,
      kellyStakeQuarter,
      edge,
      expectancy,
    };
  }, [balance, riskPercent, payoutPercent, winRate]);

  // Selected plan's config.
  const selectedPlan = plans.find((p) => p.id === selectedPlanId);
  const selectedPlanConfig: PlanConfig | null = selectedPlan
    ? (selectedPlan.config as unknown as PlanConfig)
    : null;

  // Martingale warnings.
  const martingaleWarnings = useMemo(() => {
    if (!selectedPlanConfig || !isMartingale(selectedPlanConfig)) return null;
    const cfg = selectedPlanConfig as { method: "MARTINGALE"; baseUnit: number; maxSteps: number };
    const worstCase = martingaleWorstCaseExposure(cfg.baseUnit, cfg.maxSteps);
    const capHitProb = martingaleCapHitProbability(Number(winRate) || 0.55, cfg.maxSteps);
    return { worstCase, capHitProb, maxSteps: cfg.maxSteps, baseUnit: cfg.baseUnit };
  }, [selectedPlanConfig, winRate]);

  // Run Monte Carlo simulation.
  function runSimulation() {
    if (!selectedPlanConfig) {
      toast({ title: "Select a plan first", variant: "destructive" });
      return;
    }
    setSimPending(true);
    // Use setTimeout so the UI doesn't freeze during the heavy compute.
    setTimeout(() => {
      try {
        const result = runMonteCarlo({
          startingBalance: Number(balance) || 1000,
          numSimulations: 1000,
          numTradesPerSim: 100,
          winRate: Number(winRate) || 0.55,
          payoutPercent: Number(payoutPercent) || 0.85,
          config: selectedPlanConfig,
          ruinThreshold: 0.5,
          seed: Date.now(),
        });
        setSimResult(result);
      } catch (e) {
        toast({
          title: "Simulation failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      } finally {
        setSimPending(false);
      }
    }, 50);
  }

  return (
    <div className="space-y-6">
      {/* Inputs */}
      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <FormField label="Balance" htmlFor="balance" required>
            <Input
              id="balance"
              type="number"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </FormField>
          <FormField label="Risk %" htmlFor="riskPercent" required hint="% of balance per trade">
            <Input
              id="riskPercent"
              type="number"
              step="0.1"
              value={riskPercent}
              onChange={(e) => setRiskPercent(e.target.value)}
            />
          </FormField>
          <FormField label="Payout %" htmlFor="payoutPercent" required hint="Fraction (0.85 = 85%)">
            <Input
              id="payoutPercent"
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={payoutPercent}
              onChange={(e) => setPayoutPercent(e.target.value)}
            />
          </FormField>
          <FormField
            label="Win-rate estimate"
            htmlFor="winRate"
            required
            hint="Fraction (0.55 = 55%)"
          >
            <Input
              id="winRate"
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={winRate}
              onChange={(e) => setWinRate(e.target.value)}
            />
          </FormField>
        </div>
      </Card>

      {/* Outputs */}
      {outputs && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="Recommended stake"
            value={formatMoney(outputs.recommendedStake, currency)}
            hint={`${riskPercent}% of ${formatMoney(Number(balance), currency)}`}
          />
          <StatCard
            label="Potential profit"
            value={formatMoney(outputs.potentialProfit, currency, { signed: true })}
            trend="up"
          />
          <StatCard
            label="Potential loss"
            value={formatMoney(outputs.potentialLoss, currency, { signed: true })}
            trend="down"
          />
          <StatCard
            label="Break-even win %"
            value={formatPercent(outputs.breakEven, { alreadyPercent: false, decimals: 2 })}
            hint="Win rate to break even"
          />
          <StatCard
            label="Losses to ruin"
            value={outputs.lossesToRuin}
            hint="Consecutive losses to lose 50%"
          />
          <StatCard
            label="Expectancy/trade"
            value={formatMoney(outputs.expectancy, currency, { signed: true })}
            trend={outputs.expectancy > 0 ? "up" : "down"}
            hint={`Edge: ${formatPercent(outputs.edge, { alreadyPercent: false, decimals: 4 })}`}
          />
        </div>
      )}

      {/* Kelly variants */}
      {outputs && outputs.kellyFull > 0 && (
        <Card className="p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Kelly Criterion
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-loss/30 bg-loss/5 p-3">
              <div className="text-xs text-loss font-medium">Full Kelly (aggressive)</div>
              <div className="text-xl font-bold tabular-nums">
                {formatMoney(outputs.kellyStakeFull, currency)}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatPercent(outputs.kellyFull, { alreadyPercent: false, decimals: 4 })} of
                balance
              </div>
            </div>
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <div className="text-xs text-warning font-medium">Half Kelly (recommended)</div>
              <div className="text-xl font-bold tabular-nums">
                {formatMoney(outputs.kellyStakeHalf, currency)}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatPercent(outputs.kellyFull * 0.5, { alreadyPercent: false, decimals: 4 })} of
                balance
              </div>
            </div>
            <div className="rounded-md border border-profit/30 bg-profit/5 p-3">
              <div className="text-xs text-profit font-medium">Quarter Kelly (conservative)</div>
              <div className="text-xl font-bold tabular-nums">
                {formatMoney(outputs.kellyStakeQuarter, currency)}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatPercent(outputs.kellyFull * 0.25, { alreadyPercent: false, decimals: 4 })} of
                balance
              </div>
            </div>
          </div>
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
            <strong>Full Kelly is aggressive.</strong> It maximizes long-term growth but with
            extreme volatility — drawdowns of 50%+ are common. Most professionals use half or
            quarter Kelly.
          </div>
        </Card>
      )}

      {/* Saved plans */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Staking plans
          </h2>
          <NewPlanDialog userId="" />
        </div>
        {plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved plans yet. Create one to enable the "next stake" suggestion in the Add Trade
            form.
          </p>
        ) : (
          <ul className="space-y-2">
            {plans.map((plan) => {
              const isMartingalePlan = plan.method === "MARTINGALE";
              const planConfig = plan.config as unknown as PlanConfig;
              return (
                <li
                  key={plan.id}
                  className={`flex items-center justify-between gap-3 p-3 rounded-md border ${
                    plan.id === selectedPlanId ? "border-primary bg-primary/5" : "border-border"
                  } ${isMartingalePlan ? "border-loss/40 bg-loss/5" : ""}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => setSelectedPlanId(plan.id)}
                      className="text-left min-w-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{plan.name}</span>
                        {plan.isDefault && (
                          <Badge variant="secondary" className="text-[10px]">
                            Default
                          </Badge>
                        )}
                        {isMartingalePlan && (
                          <Badge variant="destructive" className="text-[10px] gap-0.5">
                            <AlertTriangle className="size-2.5" aria-hidden="true" /> Risky
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{plan.method}</div>
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    {!plan.isDefault && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => {
                          const fd = new FormData();
                          fd.set("planId", plan.id);
                          startTransition(async () => {
                            const res = await setDefaultStakingPlanAction(fd);
                            toast({
                              title: res.ok ? "Default set" : "Failed",
                              description: res.message,
                            });
                            if (res.ok) router.refresh();
                          });
                        }}
                        disabled={pending}
                        aria-label="Set as default"
                      >
                        <Star className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive"
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("planId", plan.id);
                        startTransition(async () => {
                          const res = await deleteStakingPlanAction(fd);
                          toast({ title: res.ok ? "Deleted" : "Failed", description: res.message });
                          if (res.ok) router.refresh();
                        });
                      }}
                      disabled={pending}
                      aria-label="Delete plan"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Martingale-specific warnings */}
        {martingaleWarnings && (
          <div className="rounded-md border border-loss/40 bg-loss/10 p-4 text-sm space-y-2">
            <div className="flex items-center gap-2 text-loss font-semibold">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Martingale warnings
            </div>
            <ul className="text-xs text-loss/80 space-y-1 list-disc pl-5">
              <li>
                Base unit: ${martingaleWarnings.baseUnit}, max steps: {martingaleWarnings.maxSteps}
              </li>
              <li>
                Worst-case total exposure (all losses):{" "}
                <strong>{formatMoney(martingaleWarnings.worstCase, currency)}</strong>
              </li>
              <li>
                Probability of hitting the cap:{" "}
                <strong>
                  {formatPercent(martingaleWarnings.capHitProb, {
                    alreadyPercent: false,
                    decimals: 4,
                  })}
                </strong>{" "}
                ({(martingaleWarnings.capHitProb * 100).toFixed(2)}%)
              </li>
              <li>
                Martingale is <strong>OFF by default</strong> in RiskGuard — select it only if you
                understand the ruin risk.
              </li>
            </ul>
          </div>
        )}
      </Card>

      {/* Monte Carlo simulation */}
      {selectedPlanConfig && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Monte Carlo simulation
            </h2>
            <Button onClick={runSimulation} disabled={simPending}>
              <Calculator className="size-4 mr-2" aria-hidden="true" />
              {simPending ? "Running 1,000 sims…" : "Run 1,000 × 100 trades"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Simulates 1,000 sequences of 100 trades using the selected plan ({selectedPlan?.name}),
            your win-rate + payout. Shows the distribution of ending balances, the chance of ruin
            (balance falls below 50% of start), and the median max drawdown.
          </p>
          {simResult && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Median ending"
                  value={formatMoney(simResult.medianEndingBalance, currency)}
                  hint={`Start: ${formatMoney(Number(balance), currency)}`}
                />
                <StatCard
                  label="Mean ending"
                  value={formatMoney(simResult.meanEndingBalance, currency)}
                />
                <StatCard
                  label="Chance of ruin"
                  value={formatPercent(simResult.chanceOfRuin, {
                    alreadyPercent: false,
                    decimals: 2,
                  })}
                  trend={simResult.chanceOfRuin > 0.1 ? "down" : "neutral"}
                />
                <StatCard
                  label="Median max DD"
                  value={formatMoney(simResult.medianMaxDrawdown, currency)}
                  hint={formatPercent(simResult.medianMaxDrawdownPercent, {
                    alreadyPercent: false,
                    decimals: 2,
                  })}
                />
              </div>
              <MonteCarloChart result={simResult} currency={currency} />
              <div className="text-xs text-muted-foreground">
                P10: {formatMoney(simResult.p10EndingBalance, currency)} · P90:{" "}
                {formatMoney(simResult.p90EndingBalance, currency)} · Ruined:{" "}
                {simResult.ruinedCount}/{simResult.numSimulations}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * NewPlanDialog — create a new staking plan with method + JSON config.
 * For simplicity, the config is entered as JSON (Phase 8.x can add form
 * fields per method).
 */
function NewPlanDialog({ userId: _userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [method, setMethod] = useState<string>("FIXED_PERCENT");
  const [configJson, setConfigJson] = useState('{"method":"FIXED_PERCENT","percent":0.02}');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const router = useRouter();

  function onMethodChange(m: string) {
    setMethod(m);
    const cfg = DEFAULT_CONFIGS[m];
    if (cfg) setConfigJson(JSON.stringify(cfg));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("method", method);
    fd.set("config", configJson);
    fd.set("isDefault", "true");
    startTransition(async () => {
      const res = await createStakingPlanAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ title: "Plan created", description: res.message });
      setOpen(false);
      setName("");
      router.refresh();
    });
  }

  return (
    <details>
      <summary className="cursor-pointer text-sm text-primary hover:underline">
        <Plus className="size-3 inline mr-1" aria-hidden="true" />
        New plan
      </summary>
      <form onSubmit={onSubmit} className="mt-3 space-y-3 p-3 rounded-md border border-border">
        <FormField label="Name" htmlFor="planName" required>
          <Input
            id="planName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="My 2% plan"
          />
        </FormField>
        <FormField label="Method" htmlFor="method" required>
          <select
            id="method"
            value={method}
            onChange={(e) => onMethodChange(e.target.value)}
            disabled={pending}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Config (JSON)"
          htmlFor="config"
          required
          hint="Edit the JSON to tune the plan's parameters."
        >
          <textarea
            id="config"
            rows={4}
            value={configJson}
            onChange={(e) => setConfigJson(e.target.value)}
            disabled={pending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          />
        </FormField>
        {method === "MARTINGALE" && (
          <div className="rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss">
            ⚠️ Martingale is high-risk. Worst-case exposure grows exponentially with maxSteps.
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={pending || !name} size="sm">
          {pending ? "Creating…" : "Create plan"}
        </Button>
      </form>
    </details>
  );
}
