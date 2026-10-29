import { classifyTradeBySession } from "@/lib/news/sessions";

export type SessionKey =
  | "ASIAN"
  | "LONDON"
  | "NEW_YORK"
  | "ASIAN_LONDON_OVERLAP"
  | "LONDON_NY_OVERLAP"
  | "OFF_HOURS";

export const SESSION_INFO: Record<
  SessionKey,
  { name: string; focus: string[]; advice: string }
> = {
  ASIAN: {
    name: "Asian (Tokyo)",
    focus: ["USD_JPY", "AUD_USD", "NZD_USD"],
    advice: "Usually range-bound. Look for clean ranges/breakouts on JPY/AUD/NZD pairs. Avoid chasing.",
  },
  LONDON: {
    name: "London",
    focus: ["EUR_USD", "GBP_USD", "EUR_GBP", "USD_CHF"],
    advice: "Good liquidity. Often sets the tone for the day. Watch for breakouts after Asian range.",
  },
  NEW_YORK: {
    name: "New York",
    focus: ["EUR_USD", "GBP_USD", "USD_CAD", "USD_JPY"],
    advice: "High liquidity with US news. Great for trending setups on major pairs.",
  },
  ASIAN_LONDON_OVERLAP: {
    name: "Asian–London Overlap",
    focus: ["EUR_JPY", "GBP_JPY", "EUR_USD"],
    advice: "Can be choppy. Only trade if you see a clear, clean setup.",
  },
  LONDON_NY_OVERLAP: {
    name: "London–New York Overlap",
    focus: ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"],
    advice: "Peak liquidity. Often the best window for binary options. Focus on EUR/USD & GBP/USD first.",
  },
  OFF_HOURS: {
    name: "Off-Hours",
    focus: ["EUR_USD"],
    advice: "Thin liquidity, wider spreads. Better to sit out unless you have a very specific edge.",
  },
};

export function getCurrentSession(): SessionKey {
  return classifyTradeBySession(new Date()) as SessionKey;
}

export function getSessionFocus(session: SessionKey): string[] {
  return SESSION_INFO[session]?.focus ?? ["EUR_USD", "GBP_USD"];
}
