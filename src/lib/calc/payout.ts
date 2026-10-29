export function calculateProfit(stake: number, payoutPercent: number): number {
  return stake * payoutPercent;
}

export function calculateLoss(stake: number): number {
  return -stake;
}

export function calculateBreakevenWinRate(payoutPercent: number): number {
  // Breakeven = 1 / (1 + payoutPercent)
  return 1 / (1 + payoutPercent);
}

export function calculateExpectedValue(
  winRate: number,
  payoutPercent: number,
  stake: number
): number {
  const profit = calculateProfit(stake, payoutPercent);
  const loss = -stake;
  return winRate * profit + (1 - winRate) * loss;
}
