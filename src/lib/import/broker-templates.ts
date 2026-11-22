/**
 * Broker statement templates — browser-safe (no Node, Prisma or AI imports).
 *
 * Templates only choose COLUMNS. They never inspect or rewrite row values, and
 * the import preview still shows every parsed row for human approval.
 */

export type MappableField =
  | "date"
  | "type"
  | "amount"
  | "asset"
  | "stake"
  | "result"
  | "direction"
  | "payoutPercent"
  | "note";

export type BrokerTemplate = {
  id: string;
  label: string;
  aliases: Record<string, MappableField>;
  /** Positional fallback for exports whose headers are unreliable. */
  fixedColumns?: Partial<Record<MappableField, number>>;
};

/** Default aliases shared by `autoColumnMap` and the "auto" template. */
export const HEADER_ALIASES: Record<string, MappableField> = {
  date: "date",
  "trade date": "date",
  "transaction date": "date",
  "value date": "date",
  time: "date",
  timestamp: "date",
  "opened at": "date",
  type: "type",
  "transaction type": "type",
  action: "type",
  activity: "type",
  amount: "amount",
  "profit/loss": "amount",
  "profit loss": "amount",
  pnl: "amount",
  "net p/l": "amount",
  credit: "amount",
  debit: "amount",
  value: "amount",
  asset: "asset",
  pair: "asset",
  symbol: "asset",
  instrument: "asset",
  market: "asset",
  stake: "stake",
  "trade size": "stake",
  investment: "stake",
  result: "result",
  outcome: "result",
  status: "result",
  direction: "direction",
  option: "direction",
  payout: "payoutPercent",
  "payout %": "payoutPercent",
  note: "note",
  description: "note",
  details: "note",
};

export const BROKER_TEMPLATES: BrokerTemplate[] = [
  { id: "auto", label: "Auto-detect (recommended)", aliases: HEADER_ALIASES },
  {
    id: "deriv",
    label: "Deriv / Binary.com",
    aliases: {
      "purchase date": "date",
      "sale date": "date",
      "trade date": "date",
      contract: "asset",
      "contract description": "asset",
      "profit/loss": "amount",
      "net profit": "amount",
      payout: "payoutPercent",
      result: "result",
      "trade result": "result",
      "buy price": "stake",
      "initial price": "stake",
      reference: "note",
    },
  },
  {
    id: "iq-option",
    label: "IQ Option",
    aliases: {
      date: "date",
      time: "date",
      asset: "asset",
      "asset name": "asset",
      direction: "direction",
      option: "direction",
      amount: "stake",
      investment: "stake",
      profit: "amount",
      result: "result",
      outcome: "result",
      payout: "payoutPercent",
    },
  },
  {
    id: "olymptrade",
    label: "Olymp Trade",
    aliases: {
      date: "date",
      "open time": "date",
      pair: "asset",
      symbol: "asset",
      type: "type",
      operation: "type",
      amount: "stake",
      investment: "stake",
      "profit/loss": "amount",
      profit: "amount",
      result: "result",
      payout: "payoutPercent",
    },
  },
  {
    id: "pocket-option",
    label: "Pocket Option",
    aliases: {
      date: "date",
      time: "date",
      asset: "asset",
      "asset pair": "asset",
      direction: "direction",
      investment: "stake",
      amount: "stake",
      "payout %": "payoutPercent",
      payout: "payoutPercent",
      result: "result",
      profit: "amount",
    },
  },
  {
    id: "mt5",
    label: "MT5 / Exness-style report",
    aliases: {
      time: "date",
      "close time": "date",
      symbol: "asset",
      type: "type",
      volume: "stake",
      profit: "amount",
      swap: "note",
      comment: "note",
    },
  },
];

export function isBrokerTemplateId(value: string | null | undefined): boolean {
  return BROKER_TEMPLATES.some((t) => t.id === value);
}

export function resolveBrokerTemplate(value: string | null | undefined): BrokerTemplate {
  return BROKER_TEMPLATES.find((t) => t.id === value) ?? BROKER_TEMPLATES[0];
}
