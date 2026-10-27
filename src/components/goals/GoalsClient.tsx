"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/trader/FormField";
import { FormError, FormSuccess } from "@/components/auth/AuthShell";
import { MoneyText } from "@/components/trader/MoneyText";
import { checkRealisticGoal, compoundingPlan, type WithdrawalRule } from "@/lib/calc/compounding";
import {
  createGoalAction,
  deleteGoalAction,
  updateDailyJournalAction,
  updateChecklistAction,
} from "@/server/actions/goals";
import { startSessionAction, endSessionAction } from "@/server/actions/sessions";
import { toast } from "@/hooks/use-toast";
import {
  Target,
  Play,
  Square,
  CheckCircle2,
  Plus,
  Trash2,
  Calendar,
  TrendingUp,
  AlertTriangle,
  BookOpen,
  ListChecks,
} from "lucide-react";
import { formatMoney, formatDate, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

type GoalWithProgress = {
  id: string;
  type: string;
  target: number;
  progress: number;
  progressPct: number;
  startDate: string;
  endDate: string;
  daysToTarget: number;
};

type ActiveSession = {
  id: string;
  tradingAccountId: string;
  startedAt: string;
  startBalance: number;
  mood: string | null;
};

type SessionSummary = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startBalance: number;
  endBalance: number | null;
  netPL: number;
  wins: number;
  losses: number;
  winRate: number;
  tradeCount: number;
  brokePlanCount: number;
  mood: string | null;
  notes: string | null;
};

type AccountLite = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: "DEMO" | "REAL";
  currentBalance: string;
};

export function GoalsClient({
  goals,
  activeSession,
  accounts,
  activeAccountId,
  checklistItems,
  sessions,
  todayJournal,
  balance,
  currency,
}: {
  goals: GoalWithProgress[];
  activeSession: ActiveSession | null;
  accounts: AccountLite[];
  activeAccountId: string | null;
  checklistItems: string[];
  sessions: SessionSummary[];
  todayJournal: string;
  balance: number;
  currency: string;
}) {
  return (
    <div className="space-y-6">
      {/* Goals */}
      <GoalsSection goals={goals} currency={currency} balance={balance} />

      {/* Sessions */}
      <SessionsSection
        activeSession={activeSession}
        accounts={accounts}
        activeAccountId={activeAccountId}
        sessions={sessions}
        currency={currency}
        checklistItems={checklistItems}
      />

      {/* Daily journal */}
      <DailyJournalSection todayJournal={todayJournal} />

      {/* Compounding planner */}
      <CompoundingPlannerSection balance={balance} currency={currency} />
    </div>
  );
}

// ─── Goals Section ──────────────────────────────────────────────────────────

function GoalsSection({
  goals,
  currency,
  balance,
}: {
  goals: GoalWithProgress[];
  currency: string;
  balance: number;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Target className="size-4" aria-hidden="true" />
          Goals
        </h2>
        <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
          <Plus className="size-3.5 mr-1" aria-hidden="true" />
          {showForm ? "Cancel" : "New goal"}
        </Button>
      </div>

      {showForm && <GoalForm currency={currency} balance={balance} />}

      {goals.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">
          No active goals. Set a daily, weekly, or monthly profit target to keep yourself
          accountable.
        </p>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} currency={currency} balance={balance} />
          ))}
        </div>
      )}
    </Card>
  );
}

function GoalCard({
  goal,
  currency,
  balance,
}: {
  goal: GoalWithProgress;
  currency: string;
  balance: number;
}) {
  const realistic = checkRealisticGoal({
    currentBalance: balance,
    targetAmount: goal.target,
    daysToTarget: goal.daysToTarget,
  });

  return (
    <div className="rounded-md border border-border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{goal.type}</Badge>
          <span className="text-sm font-medium">Target: {formatMoney(goal.target, currency)}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {goal.daysToTarget > 0 ? `${goal.daysToTarget} days left` : "Expired"}
        </span>
      </div>
      <div>
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-medium tabular-nums">
            {formatMoney(goal.progress, currency, { signed: true })} / {goal.progressPct.toFixed(0)}
            %
          </span>
        </div>
        <Progress
          value={goal.progressPct}
          indicatorClassName={
            goal.progressPct >= 100
              ? "bg-profit"
              : goal.progressPct >= 50
                ? "bg-primary"
                : "bg-muted-foreground"
          }
        />
      </div>
      {realistic.warning && (
        <p
          className={cn(
            "text-xs",
            realistic.realistic ? "text-amber-600 dark:text-amber-400" : "text-loss",
          )}
        >
          <AlertTriangle className="size-3 inline mr-1" aria-hidden="true" />
          {realistic.warning}
        </p>
      )}
    </div>
  );
}

function GoalForm({ currency, balance }: { currency: string; balance: number }) {
  const [type, setType] = useState("DAILY");
  const [targetAmount, setTargetAmount] = useState("");
  const [endDate, setEndDate] = useState(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const router = useRouter();

  // Realistic check preview.
  const target = Number(targetAmount) || 0;
  const days = Math.ceil((new Date(endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const realistic =
    target > 0 && days > 0
      ? checkRealisticGoal({ currentBalance: balance, targetAmount: target, daysToTarget: days })
      : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const fd = new FormData();
    fd.set("type", type);
    fd.set("targetAmount", targetAmount);
    fd.set("startDate", new Date().toISOString().slice(0, 10));
    fd.set("endDate", endDate);
    startTransition(async () => {
      const res = await createGoalAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ title: "Goal created", description: res.message });
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-3" noValidate>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <FormField label="Type" htmlFor="goalType">
          <select
            id="goalType"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="BALANCE_TARGET">Balance target</option>
          </select>
        </FormField>
        <FormField label="Target" htmlFor="targetAmount" required>
          <Input
            id="targetAmount"
            type="number"
            step="0.01"
            value={targetAmount}
            onChange={(e) => setTargetAmount(e.target.value)}
            placeholder={formatMoney(100, currency)}
            disabled={pending}
          />
        </FormField>
        <FormField label="End date" htmlFor="endDate" required>
          <Input
            id="endDate"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={pending}
          />
        </FormField>
        <div className="flex items-end">
          <Button type="submit" disabled={pending || !targetAmount} size="sm" className="h-9">
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
      {realistic?.warning && (
        <p
          className={cn(
            "text-xs",
            realistic.realistic ? "text-amber-600 dark:text-amber-400" : "text-loss",
          )}
        >
          <AlertTriangle className="size-3 inline mr-1" aria-hidden="true" />
          {realistic.warning}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

// ─── Sessions Section ──────────────────────────────────────────────────────

function SessionsSection({
  activeSession,
  accounts,
  activeAccountId,
  sessions,
  currency,
  checklistItems,
}: {
  activeSession: ActiveSession | null;
  accounts: AccountLite[];
  activeAccountId: string | null;
  sessions: SessionSummary[];
  currency: string;
  checklistItems: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [selectedMood, setSelectedMood] = useState("FOCUSED");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | undefined>();
  const router = useRouter();

  function toggleItem(item: string) {
    setCheckedItems((s) => {
      const next = new Set(s);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }

  async function startSession() {
    setError(undefined);
    if (checkedItems.size < checklistItems.length) {
      setError("Complete all checklist items before starting a session.");
      return;
    }
    const fd = new FormData();
    fd.set("tradingAccountId", activeAccountId ?? accounts[0]?.id ?? "");
    fd.set("mood", selectedMood);
    fd.set("checklistConfirmed", "true");
    startTransition(async () => {
      const res = await startSessionAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ title: "Session started", description: res.message });
      setCheckedItems(new Set());
      router.refresh();
    });
  }

  async function endSession() {
    setError(undefined);
    const fd = new FormData();
    fd.set("sessionId", activeSession!.id);
    fd.set("notes", notes);
    startTransition(async () => {
      const res = await endSessionAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ title: "Session ended", description: res.message });
      setNotes("");
      router.refresh();
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Play className="size-4" aria-hidden="true" />
        Trading Sessions
      </h2>

      {/* Active session or start controls */}
      {activeSession ? (
        <div className="space-y-3">
          <div className="rounded-md border border-profit/30 bg-profit/5 p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-profit">Session active</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  Started {formatDate(activeSession.startedAt, { withTime: true })}
                </span>
              </div>
              {activeSession.mood && <Badge variant="secondary">{activeSession.mood}</Badge>}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Start balance: {formatMoney(activeSession.startBalance, currency)}
            </div>
          </div>
          <FormField label="Session notes (end-of-session reflection)" htmlFor="sessionNotes">
            <Textarea
              id="sessionNotes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="How did the session go? What did you learn?"
            />
          </FormField>
          <Button onClick={endSession} disabled={pending} variant="destructive" size="sm">
            <Square className="size-3.5 mr-1.5" aria-hidden="true" />
            {pending ? "Ending…" : "End session"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Pre-trade checklist */}
          <div className="rounded-md border border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5 mb-2">
              <ListChecks className="size-3.5" aria-hidden="true" />
              Pre-trade checklist
            </h3>
            <div className="space-y-1.5">
              {checklistItems.map((item) => (
                <label key={item} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={checkedItems.has(item)}
                    onChange={() => toggleItem(item)}
                    className="size-4 rounded border-input"
                  />
                  <span
                    className={cn(checkedItems.has(item) && "line-through text-muted-foreground")}
                  >
                    {item}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Mood selector */}
          <FormField label="How are you feeling?" htmlFor="mood">
            <select
              id="mood"
              value={selectedMood}
              onChange={(e) => setSelectedMood(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="FOCUSED">Focused</option>
              <option value="CALM">Calm</option>
              <option value="TIRED">Tired</option>
              <option value="FRUSTRATED">Frustrated</option>
              <option value="CONFIDENT">Confident</option>
              <option value="REVENGEFUL">Revengeful</option>
            </select>
          </FormField>

          <Button
            onClick={startSession}
            disabled={pending || checkedItems.size < checklistItems.length}
            size="sm"
          >
            <Play className="size-3.5 mr-1.5" aria-hidden="true" />
            {pending ? "Starting…" : "Start session"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {/* Recent sessions */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent sessions
          </h3>
          {sessions.map((s) => (
            <div key={s.id} className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {formatDate(s.startedAt, { withTime: true })}
                  {s.endedAt && ` → ${formatDate(s.endedAt, { withTime: true })}`}
                </span>
                {s.mood && (
                  <Badge variant="outline" className="text-[10px]">
                    {s.mood}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-4 text-xs">
                <MoneyText amount={s.netPL} currency={currency} signed />
                <span className="text-muted-foreground">
                  {s.tradeCount} trades · {s.wins}W/{s.losses}L · {(s.winRate * 100).toFixed(0)}% WR
                </span>
                {s.brokePlanCount > 0 && (
                  <span className="text-loss">
                    {s.brokePlanCount} plan breach{s.brokePlanCount === 1 ? "" : "es"}
                  </span>
                )}
              </div>
              {s.notes && <p className="text-xs text-muted-foreground italic mt-1">{s.notes}</p>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Daily Journal ────────────────────────────────────────────────────────

function DailyJournalSection({ todayJournal }: { todayJournal: string }) {
  const [entry, setEntry] = useState(todayJournal);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const router = useRouter();
  const todayStr = new Date().toISOString().slice(0, 10);

  async function save() {
    const fd = new FormData();
    fd.set("date", todayStr);
    fd.set("entry", entry);
    startTransition(async () => {
      const res = await updateDailyJournalAction(fd);
      if (res.ok) {
        setSaved(true);
        toast({ title: "Journal saved" });
        router.refresh();
        setTimeout(() => setSaved(false), 2000);
      }
    });
  }

  return (
    <Card className="p-5 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <BookOpen className="size-4" aria-hidden="true" />
        Daily Journal — {formatDate(new Date())}
      </h2>
      <Textarea
        rows={4}
        value={entry}
        onChange={(e) => setEntry(e.target.value)}
        placeholder="End-of-day reflection: What went well? What did you learn? What will you do differently tomorrow?"
      />
      <div className="flex justify-end gap-2">
        <Button onClick={save} disabled={pending} size="sm">
          {pending ? "Saving…" : saved ? "Saved ✓" : "Save entry"}
        </Button>
      </div>
    </Card>
  );
}

// ─── Compounding Planner ───────────────────────────────────────────────────

function CompoundingPlannerSection({ balance, currency }: { balance: number; currency: string }) {
  const [dailyPct, setDailyPct] = useState("2");
  const [numDays, setNumDays] = useState("30");
  const [withdrawalType, setWithdrawalType] = useState("none");
  const [withdrawalValue, setWithdrawalValue] = useState("50");

  const result = (() => {
    const pct = Number(dailyPct) / 100;
    const days = Number(numDays);
    if (pct <= 0 || days <= 0) return null;

    let rule: WithdrawalRule = { type: "none" };
    if (withdrawalType === "percentOfProfit")
      rule = { type: "percentOfProfit", percent: Number(withdrawalValue) / 100 };
    else if (withdrawalType === "fixed") rule = { type: "fixed", amount: Number(withdrawalValue) };

    return compoundingPlan({
      startBalance: balance,
      dailyGrowthPercent: pct,
      numDays: days,
      withdrawalRule: rule,
    });
  })();

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <TrendingUp className="size-4" aria-hidden="true" />
        Compounding Planner
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <FormField label="Daily growth %" htmlFor="dailyPct">
          <Input
            id="dailyPct"
            type="number"
            step="0.1"
            value={dailyPct}
            onChange={(e) => setDailyPct(e.target.value)}
          />
        </FormField>
        <FormField label="Days" htmlFor="numDays">
          <Input
            id="numDays"
            type="number"
            value={numDays}
            onChange={(e) => setNumDays(e.target.value)}
          />
        </FormField>
        <FormField label="Withdrawal" htmlFor="withdrawalType">
          <select
            id="withdrawalType"
            value={withdrawalType}
            onChange={(e) => setWithdrawalType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="none">No withdrawal</option>
            <option value="percentOfProfit">% of profit</option>
            <option value="fixed">Fixed $/day</option>
          </select>
        </FormField>
        {withdrawalType !== "none" && (
          <FormField
            label={withdrawalType === "percentOfProfit" ? "Withdraw %" : "Withdraw $"}
            htmlFor="withdrawalValue"
          >
            <Input
              id="withdrawalValue"
              type="number"
              step="0.1"
              value={withdrawalValue}
              onChange={(e) => setWithdrawalValue(e.target.value)}
            />
          </FormField>
        )}
      </div>

      {result && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground">Final balance</div>
              <div className="text-lg font-bold tabular-nums">
                {formatMoney(result.finalBalance, currency)}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground">Total growth</div>
              <div className="text-lg font-bold tabular-nums text-profit">
                +{formatPercent(result.totalGrowthPercent, { alreadyPercent: false, decimals: 1 })}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground">Total withdrawn</div>
              <div className="text-lg font-bold tabular-nums">
                {formatMoney(result.totalWithdrawn, currency)}
              </div>
            </div>
          </div>

          {/* Projection table */}
          <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left">Day</th>
                  <th className="px-2 py-1.5 text-right">Start</th>
                  <th className="px-2 py-1.5 text-right">Growth</th>
                  <th className="px-2 py-1.5 text-right">Withdraw</th>
                  <th className="px-2 py-1.5 text-right">End</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.rows.map((row) => (
                  <tr key={row.day}>
                    <td className="px-2 py-1">{row.day}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {formatMoney(row.startBalance, currency)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-profit">
                      +{formatMoney(row.growth, currency)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {row.withdrawal > 0 ? `-${formatMoney(row.withdrawal, currency)}` : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                      {formatMoney(row.endBalance, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
