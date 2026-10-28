export function isMarketClosed(date: Date = new Date()): boolean {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  // Forex market is closed over weekend (roughly)
  if (day === 0 || day === 6) {
    return true;
  }
  return false;
}

export function isHoliday(_date: Date = new Date()): boolean {
  // Basic implementation - can be extended
  return false;
}
