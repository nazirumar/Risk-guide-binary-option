import { db } from "@/lib/db";
import { getCurrentSession, SESSION_INFO } from "@/lib/market/session-recommendations";
import { isMarketClosed } from "@/lib/market/market-hours";

export async function buildRecommendationMessage(): Promise<string> {
  const now = new Date();
  const session = getCurrentSession();
  const info = SESSION_INFO[session];
  const marketClosed = isMarketClosed(now);

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    include: { marketCondition: true },
  });

  const pairs = instruments
    .map((inst) => {
      const mc = inst.marketCondition;
      if (!mc) return null;
      return {
        symbol: inst.symbol,
        displayName: inst.symbol.replace("_", "/"),
        score: mc.score,
        rating: mc.rating,
        session: (mc.meta as any)?.session ?? null,
      };
    })
    .filter(Boolean) as Array<{
    symbol: string;
    displayName: string;
    score: number;
    rating: string;
    session: string | null;
  }>;

  // Prefer pairs that are GOOD and in session focus
  const focus = info.focus;
  const scored = pairs
    .filter((p) => p.rating === "GOOD" || p.rating === "CAUTION")
    .map((p) => {
      let bonus = 0;
      if (focus.includes(p.symbol)) bonus += 10;
      if (p.rating === "GOOD") bonus += 5;
      return { ...p, total: p.score + bonus };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  let msg = `<b>RiskGuard Session Recommendation</b>\n\n`;
  msg += `<b>Session:</b> ${info.name}\n`;
  msg += `<b>Market:</b> ${marketClosed ? "CLOSED" : "OPEN"}\n\n`;
  msg += `<b>Advice:</b> ${info.advice}\n\n`;

  if (scored.length === 0) {
    msg += `<b>Top Pairs:</b>\nNone rated GOOD right now. Consider waiting or check lower timeframes carefully.\n\n`;
  } else {
    msg += `<b>Best Pairs To Watch:</b>\n`;
    scored.forEach((p, i) => {
      const emoji = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "•";
      msg += `${emoji} <b>${p.displayName}</b> — ${p.rating} (${p.score})\n`;
    });
    msg += `\n`;
  }

  msg += `<b>Quick Rules:</b>\n`;
  msg += `• Focus on <b>#1</b> pair first\n`;
  msg += `• Only trade if setup is clean (no chasing)\n`;
  msg += `• Watch for news before entering\n`;
  msg += `• Use strict risk management\n\n`;
  msg += `<i>Market conditions only — not a trading signal or financial advice.</i>`;

  return msg;
}
