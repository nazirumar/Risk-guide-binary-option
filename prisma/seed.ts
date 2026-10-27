/**
 * RiskGuard Prisma seed — Phase 1.
 *
 * Creates a deterministic demo dataset so dev work has realistic data:
 *   - 1 demo user (email: demo@riskguard.app, password: riskguard1234)
 *   - 2 trading accounts (1 DEMO + 1 REAL)
 *   - 3 strategies (Bollinger Bounce, Trend Follow, News Spike)
 *   - 150 realistic trades spread over ~30 days, with realistic
 *     win/loss distribution, stakes, payouts, emotions, tags, balanceAfter
 *   - deposits/withdrawals on both accounts
 *   - 1 risk profile (per-account on the DEMO, 2% risk, 6% daily loss, 3 consec losses)
 *
 * Deterministic RNG so tests can assert on the seed output.
 */

import {
  PrismaClient,
  type TradeResult,
  type TradeDirection,
  type TradeEmotion,
} from "@prisma/client";
import Decimal from "decimal.js";
import argon2 from "argon2";

const prisma = new PrismaClient();

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────
// So tests and seed runs produce identical data.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261026);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const randDecimal = (min: number, max: number, dp = 2) =>
  new Decimal(min + rand() * (max - min)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);

// ─── Demo data pools ───────────────────────────────────────────────────────
const ASSETS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "EUR/JPY",
  "AUD/USD",
  "USD/CAD",
  "BTC/USD",
  "ETH/USD",
  "GBP/JPY",
  "EUR/GBP",
];
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1"];
const EMOTIONS: TradeEmotion[] = [
  "CALM",
  "CONFIDENT",
  "FEARFUL",
  "GREEDY",
  "REVENGE",
  "TIRED",
  "BORED",
];
const TAGS_POOL = [
  "london-session",
  "ny-session",
  "asian-session",
  "news",
  "trend",
  "reversal",
  "breakout",
  "support",
  "resistance",
  "scalp",
  "high-impact",
];
const PAYOUT_RANGE: [number, number] = [0.7, 0.92];
const EXPIRY_OPTIONS = [1, 3, 5, 10, 15, 30, 60];

// Win probability tuned so the demo trader has a small net edge after broker payout.
// 55% win × 0.85 payout - 45% loss × 1 = 0.4675 - 0.45 = +0.0175 per trade, before variance.
const BASE_WIN_PROB = 0.55;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Decide WIN / LOSS / TIE for a trade. TIE is rare (~3%). After 2 consecutive
 * losses the next trade is more likely to be a LOSS (revenge-tilt simulation),
 * and during "REVENGE" emotion trades the win prob drops to 0.40 — this gives
 * the analytics in Phase 9 something interesting to surface.
 */
function decideResult(emotion: TradeEmotion, consecutiveLosses: number): TradeResult {
  const tieRoll = rand();
  if (tieRoll < 0.03) return "TIE";
  let winProb = BASE_WIN_PROB;
  if (emotion === "REVENGE") winProb = 0.4;
  if (consecutiveLosses >= 2) winProb -= 0.1;
  return rand() < winProb ? "WIN" : "LOSS";
}

function computeProfitLoss(stake: Decimal, payout: Decimal, result: TradeResult): Decimal {
  // WIN: stake * payout; LOSS: -stake; TIE: 0
  if (result === "WIN") return stake.mul(payout);
  if (result === "LOSS") return stake.neg();
  return new Decimal(0);
}

// ─── Main seed ─────────────────────────────────────────────────────────────

async function main() {
  console.log("→ Cleaning existing data…");
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.lockout.deleteMany();
  await prisma.goal.deleteMany();
  await prisma.tradingSession.deleteMany();
  await prisma.stakingPlan.deleteMany();
  await prisma.riskProfile.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.strategy.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.account.deleteMany();
  await prisma.authenticator.deleteMany();
  await prisma.user.deleteMany();

  // ─── 1. Demo user ────────────────────────────────────────────────────────
  console.log("→ Creating demo user…");
  const passwordHash = await argon2.hash("riskguard1234");
  const user = await prisma.user.create({
    data: {
      email: "demo@riskguard.app",
      name: "Demo Trader",
      passwordHash,
      timezone: "Africa/Lagos",
      baseCurrency: "USD",
      // Auto-verified + auto-onboarded so demo users can log straight in
      // and see the seeded data. Real sign-ups go through the verification +
      // onboarding wizard flow.
      emailVerified: new Date(),
      isOnboarded: true,
    },
  });

  // ─── 2. Two trading accounts ─────────────────────────────────────────────
  console.log("→ Creating trading accounts…");
  const demoAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      name: "Quotex Demo",
      broker: "Quotex",
      currency: "USD",
      type: "DEMO",
      startingBalance: new Decimal("10000"),
      currentBalance: new Decimal("10000"),
    },
  });
  const realAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      name: "PocketOption Live",
      broker: "PocketOption",
      currency: "USD",
      type: "REAL",
      startingBalance: new Decimal("500"),
      currentBalance: new Decimal("500"),
    },
  });

  // ─── 3. Three strategies ─────────────────────────────────────────────────
  console.log("→ Creating strategies…");
  const strategies = await Promise.all([
    prisma.strategy.create({
      data: {
        userId: user.id,
        name: "Bollinger Bounce",
        description:
          "Mean-reversion on M5 — wait for close outside band, enter on rejection candle.",
        color: "#3b82f6",
        isActive: true,
      },
    }),
    prisma.strategy.create({
      data: {
        userId: user.id,
        name: "Trend Follow",
        description: "EMA 9/21 crossover with ADT > 25 on M15.",
        color: "#10b981",
        isActive: true,
      },
    }),
    prisma.strategy.create({
      data: {
        userId: user.id,
        name: "News Spike",
        description: "Trade the immediate reaction to red-folder news on M1, 60s expiry.",
        color: "#f59e0b",
        isActive: true,
      },
    }),
  ]);

  // ─── 4. Deposits / withdrawals / bonus / adjustment ───────────────────────
  // NOTE: we do NOT seed an "initial deposit" matching startingBalance — that
  // would double-count (currentBalance = startingBalance + Σ(tx) + Σ(trades)).
  // The seeded transactions below are SEPARATE money flows that happened AFTER
  // account creation: bonus credits, withdrawals, reconciliation adjustments.
  console.log("→ Creating transactions…");
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  await prisma.transaction.createMany({
    data: [
      {
        tradingAccountId: realAccount.id,
        type: "BONUS",
        amount: new Decimal("50"),
        note: "Welcome bonus credit",
        occurredAt: twentyNineDaysAgo(),
      },
      {
        tradingAccountId: realAccount.id,
        type: "WITHDRAWAL",
        amount: new Decimal("100"),
        note: "Cash out 1 week of profit",
        occurredAt: tenDaysAgo,
      },
      {
        tradingAccountId: demoAccount.id,
        type: "ADJUSTMENT",
        amount: new Decimal("12.34"),
        note: "Reconcile against broker statement",
        occurredAt: fiveDaysAgo,
      },
    ],
  });

  // ─── 5. One risk profile (per-account on the DEMO) ───────────────────────
  console.log("→ Creating risk profile…");
  await prisma.riskProfile.create({
    data: {
      userId: user.id,
      tradingAccountId: demoAccount.id,
      riskPerTradePercent: new Decimal("2"),
      maxDailyLossPercent: new Decimal("6"),
      maxDailyLossAmount: new Decimal("600"),
      dailyProfitTargetPercent: new Decimal("4"),
      maxTradesPerDay: 10,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 15,
      maxOpenTrades: 3,
      weeklyLossLimitPercent: new Decimal("12"),
      lockoutEnabled: true,
    },
  });

  // ─── 6. 150 realistic trades ────────────────────────────────────────────
  console.log("→ Generating 150 trades…");
  const trades: Array<{
    userId: string;
    tradingAccountId: string;
    strategyId: string | null;
    asset: string;
    direction: TradeDirection;
    stake: Decimal;
    payoutPercent: Decimal;
    expiryMinutes: number;
    openedAt: Date;
    closedAt: Date;
    result: TradeResult;
    profitLoss: Decimal;
    balanceAfter: Decimal;
    timeframe: string;
    setupNotes: string;
    emotion: TradeEmotion;
    followedPlan: boolean;
    tags: string[];
  }> = [];

  let demoBalance = demoAccount.startingBalance;
  let realBalance = realAccount.startingBalance;
  let consecutiveLosses = 0;

  for (let i = 0; i < 150; i++) {
    // Trade opens somewhere in the last 30 days, weighted toward recent.
    const daysAgo = Math.floor(rand() * 30);
    const hourOffset = randInt(0, 23);
    const minuteOffset = randInt(0, 59);
    const openedAt = new Date(
      now.getTime() -
        daysAgo * 24 * 60 * 60 * 1000 -
        hourOffset * 60 * 60 * 1000 -
        minuteOffset * 60 * 1000,
    );

    // 70% of trades go on the demo account, 30% on real.
    const account = rand() < 0.7 ? demoAccount : realAccount;
    const isDemo = account.id === demoAccount.id;

    // Stake: 1-3% of current balance, rounded to whole cent.
    const balanceForStake = isDemo ? demoBalance : realBalance;
    const stakePct = randDecimal(1, 3, 2);
    const stake = balanceForStake.mul(stakePct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const payout = randDecimal(PAYOUT_RANGE[0], PAYOUT_RANGE[1], 4);
    const expiry = pick(EXPIRY_OPTIONS);
    const direction: TradeDirection = rand() < 0.5 ? "CALL" : "PUT";
    const strategy = pick(strategies);
    const asset = pick(ASSETS);
    const timeframe = pick(TIMEFRAMES);

    // Emotion: weighted toward CALM/CONFIDENT, but sprinkle in REVENGE/FEARFUL.
    const emotionRoll = rand();
    let emotion: TradeEmotion;
    if (emotionRoll < 0.4) emotion = "CALM";
    else if (emotionRoll < 0.65) emotion = "CONFIDENT";
    else if (emotionRoll < 0.75) emotion = "FEARFUL";
    else if (emotionRoll < 0.85) emotion = "GREEDY";
    else if (emotionRoll < 0.93) emotion = "TIRED";
    else if (emotionRoll < 0.98) emotion = "BORED";
    else emotion = "REVENGE";

    // followedPlan: 90% true normally, but only 50% true during REVENGE.
    const followedPlan = emotion === "REVENGE" ? rand() < 0.5 : rand() < 0.9;

    const result = decideResult(emotion, consecutiveLosses);
    const profitLoss = computeProfitLoss(stake, payout, result);

    // Update running balance.
    if (isDemo) {
      demoBalance = demoBalance.plus(profitLoss);
    } else {
      realBalance = realBalance.plus(profitLoss);
    }
    const balanceAfter = isDemo ? demoBalance : realBalance;

    // Track consecutive losses for the revenge-tilt logic.
    if (result === "LOSS") consecutiveLosses++;
    else if (result === "WIN") consecutiveLosses = 0;

    // closedAt = openedAt + expiry
    const closedAt = new Date(openedAt.getTime() + expiry * 60 * 1000);

    // 2-4 random tags from the pool.
    const tagCount = randInt(2, 4);
    const tradeTags = new Set<string>();
    for (let t = 0; t < tagCount; t++) tradeTags.add(pick(TAGS_POOL));

    trades.push({
      userId: user.id,
      tradingAccountId: account.id,
      strategyId: strategy.id,
      asset,
      direction,
      stake,
      payoutPercent: payout,
      expiryMinutes: expiry,
      openedAt,
      closedAt,
      result,
      profitLoss,
      balanceAfter,
      timeframe,
      setupNotes: setupNoteFor(asset, direction, timeframe, strategy.name),
      emotion,
      followedPlan,
      tags: Array.from(tradeTags),
    });
  }

  // Sort trades by openedAt so the chronological order matches reality.
  trades.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

  // Recompute balanceAfter in sorted order so it's a true equity walk per
  // account. The walk now also includes transactions (PROJECT_RULES.md Phase 4:
  // currentBalance = startingBalance + Σ(transactions) + Σ(trades)).
  // The starting point is startingBalance + Σ(signed transactions) —
  // i.e. the "post-deposits/withdrawals" baseline before any trades.
  const demoTxSum = (
    await prisma.transaction.findMany({
      where: { tradingAccountId: demoAccount.id },
      select: { type: true, amount: true },
    })
  ).reduce(
    (acc, t) =>
      acc.plus(
        t.type === "WITHDRAWAL"
          ? new Decimal(t.amount.toString()).neg()
          : new Decimal(t.amount.toString()),
      ),
    new Decimal(0),
  );
  const realTxSum = (
    await prisma.transaction.findMany({
      where: { tradingAccountId: realAccount.id },
      select: { type: true, amount: true },
    })
  ).reduce(
    (acc, t) =>
      acc.plus(
        t.type === "WITHDRAWAL"
          ? new Decimal(t.amount.toString()).neg()
          : new Decimal(t.amount.toString()),
      ),
    new Decimal(0),
  );

  let demoWalk = demoAccount.startingBalance.plus(demoTxSum);
  let realWalk = realAccount.startingBalance.plus(realTxSum);
  for (const t of trades) {
    if (t.tradingAccountId === demoAccount.id) {
      demoWalk = demoWalk.plus(t.profitLoss);
      t.balanceAfter = demoWalk;
    } else {
      realWalk = realWalk.plus(t.profitLoss);
      t.balanceAfter = realWalk;
    }
  }

  // Persist trades in chunks (Prisma createMany supports arrays on SQLite).
  const chunkSize = 50;
  for (let i = 0; i < trades.length; i += chunkSize) {
    await prisma.trade.createMany({ data: trades.slice(i, i + chunkSize) });
  }

  // Update currentBalance on the accounts to match the recomputed balance.
  // (In the real app this is done by `recomputeAccountBalanceInTx`; the seed
  // does the same math inline because it batches trades via createMany.)
  await prisma.tradingAccount.update({
    where: { id: demoAccount.id },
    data: { currentBalance: demoWalk },
  });
  await prisma.tradingAccount.update({
    where: { id: realAccount.id },
    data: { currentBalance: realWalk },
  });

  // ─── 7. One notification so the bell has something to show in Phase 12 ───
  await prisma.notification.create({
    data: {
      userId: user.id,
      type: "WELCOME",
      title: "Welcome to RiskGuard",
      body: "Your demo data is ready. Add a trade to see the journal in action.",
    },
  });

  // ─── 8. Audit log entry for the seed itself ──────────────────────────────
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "SEED_RUN",
      entity: "User",
      entityId: user.id,
      meta: {
        accounts: 2,
        strategies: strategies.length,
        trades: trades.length,
        demoFinalBalance: demoWalk.toString(),
        realFinalBalance: realWalk.toString(),
      },
    },
  });

  console.log("✅ Seed complete");
  console.log(`   User:           ${user.email}`);
  console.log(
    `   Accounts:       ${demoAccount.name} (DEMO, $${demoAccount.startingBalance} → $${demoWalk.toFixed(2)})`,
  );
  console.log(
    `                   ${realAccount.name} (REAL, $${realAccount.startingBalance} → $${realWalk.toFixed(2)})`,
  );
  console.log(`   Strategies:     ${strategies.length}`);
  console.log(`   Trades:         ${trades.length}`);
  console.log(`   Login:           demo@riskguard.app / riskguard1234`);
}

function twentyNineDaysAgo(): Date {
  return new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
}

function setupNoteFor(
  asset: string,
  direction: TradeDirection,
  timeframe: string,
  strategyName: string,
): string {
  const notes = [
    `${asset} ${direction} on ${timeframe} via ${strategyName} — clean setup, entered at signal.`,
    `${direction} ${asset} ${timeframe}, ${strategyName} setup confirmed by 2 confluences.`,
    `${strategyName} triggered on ${asset}. ${direction} entry, ${timeframe} chart.`,
    `${asset} ${direction} — ${strategyName} rules all met, no hesitation.`,
    `Quick ${direction} on ${asset} ${timeframe}. ${strategyName} entry, took the obvious.`,
  ];
  return pick(notes);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
