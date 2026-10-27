import { requireUser } from "@/server/lib/require-user";
import { getActiveAccount, listUserAccounts } from "@/server/actions/active-account";
import { db } from "@/lib/db";
import { GoalsClient } from "@/components/goals/GoalsClient";
import Decimal from "decimal.js";

export default async function GoalsPage() {
  const { userId } = await requireUser();
  const activeAccount = await getActiveAccount();
  const accounts = await listUserAccounts();

  // Fetch goals + active session + checklist + recent sessions + daily journal.
  const [goals, activeSession, user, sessions, trades] = await Promise.all([
    db.goal.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { endDate: "asc" },
      select: { id: true, type: true, targetAmount: true, startDate: true, endDate: true },
    }),
    db.tradingSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: "desc" },
      select: { id: true, tradingAccountId: true, startedAt: true, startBalance: true, mood: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { checklistItems: true, dailyJournal: true, timezone: true, baseCurrency: true },
    }),
    db.tradingSession.findMany({
      where: { userId, endedAt: { not: null } },
      orderBy: { endedAt: "desc" },
      take: 10,
      select: {
        id: true,
        tradingAccountId: true,
        startedAt: true,
        endedAt: true,
        startBalance: true,
        endBalance: true,
        notes: true,
        mood: true,
      },
    }),
    activeAccount
      ? db.trade.findMany({
          where: {
            userId,
            tradingAccountId: activeAccount.id,
            result: { in: ["WIN", "LOSS", "TIE"] },
          },
          orderBy: { openedAt: "desc" },
          take: 200,
          select: { profitLoss: true, result: true, openedAt: true, followedPlan: true },
        })
      : Promise.resolve([]),
  ]);

  // Compute today's P/L for goal progress.
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startOfWeek = new Date();
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());
  startOfWeek.setUTCHours(0, 0, 0, 0);
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const todayPL = trades
    .filter((t) => t.openedAt >= startOfToday)
    .reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
  const weekPL = trades
    .filter((t) => t.openedAt >= startOfWeek)
    .reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
  const monthPL = trades
    .filter((t) => t.openedAt >= startOfMonth)
    .reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);

  const balance = activeAccount ? Number(activeAccount.currentBalance) : 0;

  // Compute goal progress.
  const goalsWithProgress = goals.map((g) => {
    const target = Number(g.targetAmount.toString());
    let progress = 0;
    if (g.type === "DAILY") progress = todayPL;
    else if (g.type === "WEEKLY") progress = weekPL;
    else if (g.type === "MONTHLY") progress = monthPL;
    else if (g.type === "BALANCE_TARGET") progress = balance;

    const pct = target > 0 ? Math.min(100, (progress / target) * 100) : 0;
    const daysToTarget = Math.ceil(
      (new Date(g.endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );

    return {
      id: g.id,
      type: g.type,
      target,
      progress,
      progressPct: pct,
      startDate: g.startDate.toISOString(),
      endDate: g.endDate.toISOString(),
      daysToTarget,
    };
  });

  // Session summaries.
  const sessionSummaries = await Promise.all(
    sessions.slice(0, 5).map(async (s) => {
      const sessionTrades = await db.trade.findMany({
        where: {
          userId,
          tradingAccountId: s.tradingAccountId,
          result: { in: ["WIN", "LOSS", "TIE"] },
          openedAt: { gte: s.startedAt, lte: s.endedAt ?? new Date() },
        },
        select: { profitLoss: true, result: true, followedPlan: true },
      });
      const np = sessionTrades.reduce((acc, t) => acc + Number(t.profitLoss.toString()), 0);
      const wins = sessionTrades.filter((t) => t.result === "WIN").length;
      const brokePlan = sessionTrades.filter((t) => !t.followedPlan).length;
      return {
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        startBalance: Number(s.startBalance.toString()),
        endBalance: s.endBalance ? Number(s.endBalance.toString()) : null,
        netPL: np,
        wins,
        losses: sessionTrades.filter((t) => t.result === "LOSS").length,
        winRate: sessionTrades.length > 0 ? wins / sessionTrades.length : 0,
        tradeCount: sessionTrades.length,
        brokePlanCount: brokePlan,
        mood: s.mood,
        notes: s.notes,
      };
    }),
  );

  // Today's journal entry.
  const todayStr = new Date().toISOString().slice(0, 10);
  const journal = (user?.dailyJournal as Record<string, string>) ?? {};
  const todayJournal = journal[todayStr] ?? "";

  const checklistItems = (user?.checklistItems as string[]) ?? [
    "Checked news calendar",
    "Within trading hours",
    "Calm",
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Goals &amp; Sessions</h1>
        <p className="text-sm text-muted-foreground">
          Daily targets, trading sessions, discipline checklists, and a compounding planner.
        </p>
      </div>

      <GoalsClient
        goals={goalsWithProgress}
        activeSession={
          activeSession
            ? {
                id: activeSession.id,
                tradingAccountId: activeSession.tradingAccountId,
                startedAt: activeSession.startedAt.toISOString(),
                startBalance: Number(activeSession.startBalance.toString()),
                mood: activeSession.mood,
              }
            : null
        }
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          broker: a.broker,
          currency: a.currency,
          type: a.type as "DEMO" | "REAL",
          currentBalance: a.currentBalance.toString(),
        }))}
        activeAccountId={activeAccount?.id ?? null}
        checklistItems={checklistItems}
        sessions={sessionSummaries}
        todayJournal={todayJournal}
        balance={balance}
        currency={activeAccount?.currency ?? user?.baseCurrency ?? "USD"}
      />
    </div>
  );
}
