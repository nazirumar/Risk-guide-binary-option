/**
 * Phase 1 verification — sanity-check the seeded data from the CLI.
 * Confirms counts and that Decimal precision survives a round-trip.
 */
import { db } from "../src/lib/db";
import Decimal from "decimal.js";

async function main() {
  const [
    users,
    accounts,
    strategies,
    trades,
    transactions,
    riskProfiles,
    notifications,
    auditLogs,
  ] = await Promise.all([
    db.user.count(),
    db.tradingAccount.count(),
    db.strategy.count(),
    db.trade.count(),
    db.transaction.count(),
    db.riskProfile.count(),
    db.notification.count(),
    db.auditLog.count(),
  ]);

  console.log("Row counts:");
  console.log(`  Users:           ${users}`);
  console.log(`  TradingAccounts: ${accounts}`);
  console.log(`  Strategies:      ${strategies}`);
  console.log(`  Trades:          ${trades}`);
  console.log(`  Transactions:    ${transactions}`);
  console.log(`  RiskProfiles:    ${riskProfiles}`);
  console.log(`  Notifications:   ${notifications}`);
  console.log(`  AuditLogs:       ${auditLogs}`);

  // Decimal round-trip sanity check: pull a trade and verify stake stays precise.
  const firstTrade = await db.trade.findFirst({ orderBy: { openedAt: "asc" } });
  if (firstTrade) {
    const stake = new Decimal(firstTrade.stake.toString());
    const payout = new Decimal(firstTrade.payoutPercent.toString());
    const profitOnWin = stake.mul(payout).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    console.log("\nDecimal round-trip on first trade:");
    console.log(`  stake:           ${stake}`);
    console.log(`  payoutPercent:   ${payout}`);
    console.log(`  profitOnWin:     ${profitOnWin}`);
    console.log(`  result:          ${firstTrade.result}`);
    console.log(`  balanceAfter:    ${firstTrade.balanceAfter}`);
    console.log(`  tags:            ${JSON.stringify(firstTrade.tags)}`);
  }

  // Verify the per-user scoping index works: pull trades for one user only.
  const demoUser = await db.user.findUnique({ where: { email: "demo@riskguard.app" } });
  if (demoUser) {
    const userTrades = await db.trade.count({ where: { userId: demoUser.id } });
    console.log(`\nUserId-scoped query: demo user has ${userTrades} trades (expected 150).`);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("Verification failed:", e);
    await db.$disconnect();
    process.exit(1);
  });
